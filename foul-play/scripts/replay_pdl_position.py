"""Replay one recorded PDL decision through the existing local search stack.

The input is one bot's captured protocol stream.  It contains public Showdown
messages plus that bot's own request JSON, which is exactly the information
available at a live decision.  It intentionally never reads the separate
ground-truth audit or the opposing bot's request stream.
"""

# ruff: noqa: E402

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from fp.battle.protocol import update_battle
from fp.battle.state import Battle, LastUsedMove, Pokemon
from fp.config import FoulPlayConfig
from fp.modes.standard_battle import StandardBattleMode
from fp.pdl.belief_data import PdlBeliefData
from fp.pdl.observation import ObservedBattleState
from fp.search.main import find_best_move
from fp.teams.team_converter import export_to_dict


@dataclass(frozen=True)
class ReplayInput:
    trial_directory: Path
    actor: str
    target_turn: int | None
    search_ms: int
    requested_worlds: int
    seed: int
    target_decision_ordinal: int | None = None


class ReplayFidelityError(ValueError):
    """Raised when a recorded decision cannot be reconstructed exactly."""


@dataclass(frozen=True)
class DecisionReplayBundle:
    """One immutable, agent-visible decision input shared by all planners.

    ``observed_state`` is the only battle state given to a planner.  It has
    already crossed ``ObservedBattleState``'s serialization boundary, so it
    cannot contain the opponent's private request or audit truth.  Historical
    evidence is retained solely to verify replay fidelity before a planner is
    allowed to run.
    """

    schema_version: int
    trial_id: str
    actor: str
    decision_ordinal: int
    protocol_turn: int | bool
    request_type: str
    recorded_action: str
    legal_search_actions: tuple[str, ...]
    observation_digest: str
    observed_state: ObservedBattleState
    source_request_sha256: str

    def planner_input(self) -> ObservedBattleState:
        """Return the immutable public/private-agent projection for a planner."""
        return self.observed_state


class EvidenceCapture(logging.Handler):
    def __init__(self):
        super().__init__(logging.INFO)
        self.root_evaluations = None
        self.decision_evidence = None

    def emit(self, record):
        message = record.getMessage()
        for prefix, attribute in (
            ("PDL_ROOT_EVALUATIONS ", "root_evaluations"),
            ("PDL_DECISION_EVIDENCE ", "decision_evidence"),
        ):
            if message.startswith(prefix):
                setattr(self, attribute, json.loads(message.removeprefix(prefix)))


def parse_arguments() -> ReplayInput:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trial", required=True, type=Path)
    parser.add_argument("--actor", required=True, choices=("p1", "p2"))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--turn", type=int)
    target.add_argument("--decision-ordinal", type=int)
    parser.add_argument("--search-ms", required=True, type=int)
    parser.add_argument("--requested-worlds", default=1, type=int)
    parser.add_argument("--seed", default=0, type=int)
    args = parser.parse_args()
    if (
        (args.turn is not None and args.turn < 1)
        or (args.decision_ordinal is not None and args.decision_ordinal < 0)
        or args.search_ms < 1
        or args.requested_worlds < 1
    ):
        parser.error("turn and search-ms must be positive; decision-ordinal must be non-negative")
    return ReplayInput(
        trial_directory=args.trial.resolve(), actor=args.actor, target_turn=args.turn,
        search_ms=args.search_ms, requested_worlds=args.requested_worlds, seed=args.seed,
        target_decision_ordinal=args.decision_ordinal,
    )


def protocol_chunks(path: Path) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(">battle-"):
            if current:
                chunks.append(current)
            current = []
        elif line.startswith("|"):
            current.append(line)
    if current:
        chunks.append(current)
    return chunks


def request_from_lines(lines: list[str]):
    for line in lines:
        if line.startswith("|request|"):
            return json.loads(line.split("|", 2)[2])
    return None


def recorded_choices(path: Path) -> list[str]:
    prefix = "INFO     Choice: "
    return [
        line.removeprefix(prefix)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.startswith(prefix)
    ]


def recorded_decision_evidence(path: Path) -> list[dict[str, Any]]:
    """Pair every public digest with its evidence and selected action.

    The bot log is an auditable transcript: a public observation marker must
    precede exactly one structured decision record and exactly one choice.
    Missing or reordered records are a fidelity error, never an invitation to
    guess which historic decision they describe.
    """
    decisions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    observation_prefix = "INFO     PDL_OBSERVATION "
    evidence_prefix = "INFO     PDL_DECISION_EVIDENCE "
    choice_prefix = "INFO     Choice: "
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith(observation_prefix):
            if current is not None:
                raise ReplayFidelityError("observation marker arrived before prior decision completed")
            fields = dict(
                part.split("=", 1) for part in raw_line.removeprefix(observation_prefix).split()
                if "=" in part
            )
            if fields.get("schema") != "pdl.observed-battle.v1" or not fields.get("digest"):
                raise ReplayFidelityError("malformed PDL_OBSERVATION marker")
            current = {"observationDigest": fields["digest"]}
        elif raw_line.startswith(evidence_prefix):
            if current is None or "evidence" in current:
                raise ReplayFidelityError("decision evidence is not paired with one observation")
            try:
                evidence = json.loads(raw_line.removeprefix(evidence_prefix))
            except json.JSONDecodeError as error:
                raise ReplayFidelityError("invalid PDL_DECISION_EVIDENCE JSON") from error
            if not isinstance(evidence.get("legalSearchActions"), list) or not evidence.get("selected"):
                raise ReplayFidelityError("decision evidence omits legal actions or selection")
            current["evidence"] = evidence
        elif raw_line.startswith(choice_prefix):
            if current is None or "evidence" not in current or "choice" in current:
                raise ReplayFidelityError("choice is not paired with structured decision evidence")
            current["choice"] = raw_line.removeprefix(choice_prefix)
            if current["choice"] != current["evidence"]["selected"]:
                raise ReplayFidelityError("recorded Choice disagrees with decision evidence selection")
            decisions.append(current)
            current = None
    if current is not None:
        raise ReplayFidelityError("incomplete observation/evidence/choice record at end of log")
    if not decisions:
        raise ReplayFidelityError("recorded bot log contains no complete decision evidence")
    return decisions


def recorded_live_observations(path: Path) -> list[dict[str, Any]]:
    """Read actor-private exact observations captured by the current runtime.

    Absence is normal for archived artifacts. A present capture is strict:
    every line must be a complete, versioned decision input and it is indexed
    by its own ordinal, never matched heuristically to protocol turns.
    """
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ReplayFidelityError("invalid live decision-capture JSON") from error
        required = {
            "schemaVersion", "actor", "decisionOrdinal", "requestType",
            "activeSpecies", "observation", "observationSha256",
            "sourceRequestSha256", "selectedAction",
        }
        if not isinstance(record, dict) or record.get("schemaVersion") != 1 or not required <= record.keys():
            raise ReplayFidelityError("live decision capture omits required fields")
        if not isinstance(record["observation"], str):
            raise ReplayFidelityError("live decision capture observation is not serialized text")
        records.append(record)
    for ordinal, record in enumerate(records):
        if record["decisionOrdinal"] != ordinal:
            raise ReplayFidelityError("live decision capture ordinal sequence is not exact")
    return records


def protocol_battle_identity(chunks: list[list[str]], protocol_path: Path) -> tuple[str, dict[str, str]]:
    """Extract only public battle identity lines from the actor protocol."""
    battle_tag = None
    players: dict[str, str] = {}
    for raw_line in protocol_path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith(">battle-") and battle_tag is None:
            battle_tag = raw_line[1:]
        if raw_line.startswith("|player|"):
            parts = raw_line.split("|")
            if len(parts) >= 4 and parts[2] in {"p1", "p2"}:
                players[parts[2]] = parts[3]
    if not battle_tag:
        raise ReplayFidelityError("actor protocol omits the battle tag")
    # A request side is authoritative for the local side even if old logs did
    # not emit player lines (the compact fixture deliberately does not).
    if not chunks:
        raise ReplayFidelityError("actor protocol has no battle chunks")
    return battle_tag, players


def set_replay_config(replay: ReplayInput, belief_path: Path, team_id: str) -> None:
    FoulPlayConfig.pokemon_format = "gen9pdls4"
    FoulPlayConfig.pdl_belief_data = str(belief_path)
    FoulPlayConfig.pdl_belief = PdlBeliefData.load(belief_path)
    FoulPlayConfig.pdl_team_id = team_id
    FoulPlayConfig.pdl_belief_engine = "posterior"
    FoulPlayConfig.search_engine = "mcts"
    FoulPlayConfig.action_policy = "argmax"
    FoulPlayConfig.search_time_ms = replay.search_ms
    FoulPlayConfig.parallelism = replay.requested_worlds
    FoulPlayConfig.search_threads = 1
    FoulPlayConfig.tera_gate_minimum_support_margin = 0.01


def choice_to_last_selected(battle: Battle, choice: str) -> LastUsedMove:
    return LastUsedMove(
        battle.user.active.name if battle.user.active else "teampreview",
        choice.removesuffix("-tera").removesuffix("-mega"),
        battle.turn,
    )


def public_pokemon_snapshot(pokemon) -> dict | None:
    """Return only fields already present in the observation projection."""
    if pokemon is None:
        return None
    return {
        "species": pokemon.name,
        "hp": pokemon.hp,
        "maxHp": pokemon.max_hp,
        "status": str(pokemon.status),
        "moves": [
            {
                "name": move.name,
                "currentPp": move.current_pp,
                "maxPp": move.max_pp,
                "disabled": move.disabled,
            }
            for move in pokemon.moves
        ],
    }


def public_position_snapshot(battle: Battle) -> dict:
    """A compact, audit-friendly view of an already-projected observation."""
    return {
        "turn": battle.turn,
        "weather": str(battle.weather),
        "field": str(battle.field),
        "trickRoom": battle.trick_room,
        "user": {
            "active": public_pokemon_snapshot(battle.user.active),
            "reserve": [public_pokemon_snapshot(pokemon) for pokemon in battle.user.reserve],
            "sideConditions": dict(battle.user.side_conditions),
        },
        "opponent": {
            "active": public_pokemon_snapshot(battle.opponent.active),
            "reserve": [public_pokemon_snapshot(pokemon) for pokemon in battle.opponent.reserve],
            "sideConditions": dict(battle.opponent.side_conditions),
        },
    }


def _initialize_replay(replay: ReplayInput) -> tuple[Battle, list[list[str]], int, list[str]]:
    """Build the public pre-preview state shared by every replay target."""
    protocol_path = replay.trial_directory / f"private-{replay.actor}" / "protocol.log"
    chunks = protocol_chunks(protocol_path)
    battle_tag, player_accounts = protocol_battle_identity(chunks, protocol_path)
    preview_index = next(
        index for index, chunk in enumerate(chunks)
        if (request := request_from_lines(chunk)) and request.get("teamPreview")
    )
    preview_request = request_from_lines(chunks[preview_index])
    assert preview_request is not None
    manifest = json.loads((replay.trial_directory / "manifest.json").read_text())
    team_id = manifest[replay.actor]["teamId"]
    set_replay_config(
        replay,
        replay.trial_directory / f"private-{replay.actor}" / "belief.json",
        team_id,
    )
    mode = StandardBattleMode()
    battle = Battle(battle_tag)
    battle.generation = "gen9"
    battle.pokemon_format = "gen9pdls4"
    battle.battle_type = battle.format_spec.battle_type
    battle.mode = mode
    battle.request_json = preview_request
    own_team_path = replay.trial_directory / f"private-{replay.actor}" / "team.txt"
    if own_team_path.is_file():
        # This is the actor's own submitted team, available at a live decision.
        # Synthetic regression fixtures intentionally omit it.
        battle.user.team_dict = export_to_dict(own_team_path.read_text(encoding="utf-8"))
    battle.user.initialize_first_turn_user_from_json(preview_request)
    battle.user.account_name = player_accounts.get(replay.actor, preview_request["side"].get("name"))
    battle.opponent.name = "p2" if replay.actor == "p1" else "p1"
    battle.opponent.account_name = player_accounts.get(battle.opponent.name)
    opponent_preview = [
        line.split("|", 3)[3]
        for chunk in chunks[: preview_index + 1]
        for line in chunk
        if line.startswith(f"|poke|{battle.opponent.name}|")
    ]
    battle.initialize_team_preview(opponent_preview, "gen9pdls4")
    mode.initialize_team_preview_datasets(
        "gen9pdls4",
        {pokemon.name for pokemon in battle.user.reserve + battle.opponent.reserve},
        "",
    )

    choices = recorded_choices(replay.trial_directory / f"{replay.actor}.log")
    if not choices:
        raise ValueError("Recorded bot log contains no selected actions")
    return battle, chunks, preview_index, choices


def _preview_decision_battle(battle: Battle) -> Battle:
    """Mirror the live `handle_team_preview` search projection exactly."""
    preview = deepcopy(battle)
    preview.user.active = Pokemon.get_dummy()
    preview.opponent.active = Pokemon.get_dummy()
    preview.team_preview = True
    return preview


def request_type(request: dict) -> str:
    if request.get("teamPreview"):
        return "team-preview"
    if request.get("forceSwitch"):
        return "forced-switch"
    if request.get("active"):
        return "move"
    return "unknown"


def active_species_for_decision(battle: Battle) -> str:
    """The request-visible active species used in decision evidence.

    Team preview has no active combatant, so it uses the explicit stable token
    emitted by the live diagnostic logger.  This is intentionally a scalar
    label, never a private request payload.
    """
    if battle.team_preview:
        return "teampreview"
    return battle.user.active.name.lower() if battle.user.active else "none"


def replay_to_decision(replay: ReplayInput) -> tuple[Battle, str, dict]:
    """Return one exact action request, indexed independently of battle turn.

    The actor's private protocol is the only request source.  Each non-wait
    request receives one ordinal; ordinal zero is the team preview request.
    This deliberately does not collapse two requests arriving on one protocol
    turn into one decision.
    """
    if replay.target_decision_ordinal is None:
        raise ValueError("replay_to_decision requires target_decision_ordinal")
    battle, chunks, preview_index, choices = _initialize_replay(replay)
    target = replay.target_decision_ordinal
    preview_request = request_from_lines(chunks[preview_index])
    assert preview_request is not None
    if target == 0:
        return _preview_decision_battle(battle), choices[0], {
            "decisionOrdinal": 0,
            "protocolTurn": battle.turn,
            "requestType": request_type(preview_request),
            "recordedAction": choices[0],
            "activeSpecies": "teampreview",
        }

    choice_index = 1  # Choice zero is team preview, already resolved by protocol.
    decision_ordinal = 1
    for chunk in chunks[preview_index + 1 :]:
        update_battle(battle, "\n".join(chunk))
        request = request_from_lines(chunk)
        if request is None or request.get("wait"):
            continue
        if choice_index >= len(choices):
            raise ValueError("Recorded actions ended before target request")
        if decision_ordinal == target:
            if battle.request_json != request:
                raise ValueError("Replay request drifted from the actionable protocol chunk")
            return battle, choices[choice_index], {
                "decisionOrdinal": decision_ordinal,
                "protocolTurn": battle.turn,
                "requestType": request_type(request),
                "recordedAction": choices[choice_index],
                "activeSpecies": active_species_for_decision(battle),
            }
        battle.user.last_selected_move = choice_to_last_selected(
            battle, choices[choice_index]
        )
        choice_index += 1
        decision_ordinal += 1
    raise ValueError(f"No actionable request found at decision ordinal {target}")


def replay_to_turn(replay: ReplayInput) -> tuple[Battle, str]:
    """Legacy turn target retained only for existing fixed fixtures."""
    if replay.target_turn is None:
        raise ValueError("replay_to_turn requires target_turn")
    battle, chunks, preview_index, choices = _initialize_replay(replay)
    choice_index = 1
    for chunk in chunks[preview_index + 1 :]:
        update_battle(battle, "\n".join(chunk))
        request = request_from_lines(chunk)
        if request is None or request.get("wait"):
            continue
        if battle.turn == replay.target_turn:
            if choice_index >= len(choices):
                raise ValueError("No recorded action for target request")
            return battle, choices[choice_index]
        if battle.turn > replay.target_turn:
            break
        battle.user.last_selected_move = choice_to_last_selected(
            battle, choices[choice_index]
        )
        choice_index += 1
    raise ValueError(f"No actionable request found at turn {replay.target_turn}")


def build_decision_replay_bundle(replay: ReplayInput) -> DecisionReplayBundle:
    """Reconstruct one historical decision and prove it matches its transcript.

    Historical replay deliberately has no turn-number fallback.  If a source
    artifact lacks a matching observation digest or legal-action record, it is
    not an exact replay and cannot be passed to either planner.
    """
    if replay.target_decision_ordinal is None:
        raise ReplayFidelityError("DecisionReplayBundle requires --decision-ordinal")
    battle, recorded_action, decision = replay_to_decision(replay)
    decision_battle = deepcopy(battle)
    if not decision_battle.team_preview:
        decision_battle.user.update_from_request_json(decision_battle.request_json)
    reconstructed_observed = ObservedBattleState.capture(decision_battle)
    evidence_records = recorded_decision_evidence(replay.trial_directory / f"{replay.actor}.log")
    try:
        historical = evidence_records[replay.target_decision_ordinal]
    except IndexError as error:
        raise ReplayFidelityError(
            f"no complete historical decision evidence at ordinal {replay.target_decision_ordinal}"
        ) from error
    evidence = historical["evidence"]
    required_evidence = (
        "actor", "decisionOrdinal", "requestType", "activeSpecies", "turn",
        "legalSearchActions", "selected",
    )
    missing = [field for field in required_evidence if field not in evidence]
    if missing:
        raise ReplayFidelityError(
            "historical decision evidence omits required fidelity fields: "
            + ", ".join(missing)
        )
    if evidence["actor"] != replay.actor:
        raise ReplayFidelityError("historical evidence actor does not match replay actor")
    if evidence["decisionOrdinal"] != replay.target_decision_ordinal:
        raise ReplayFidelityError("historical evidence ordinal does not match replay ordinal")
    if evidence["requestType"] != decision["requestType"]:
        raise ReplayFidelityError("historical evidence request type does not match reconstructed request")
    if evidence["activeSpecies"] != decision["activeSpecies"]:
        raise ReplayFidelityError("historical evidence active species does not match reconstructed request")
    legal_actions = tuple(evidence["legalSearchActions"])
    if not legal_actions or len(legal_actions) != len(set(legal_actions)):
        raise ReplayFidelityError("historical legal action record is empty or contains duplicates")
    if recorded_action != historical["choice"] or recorded_action != evidence["selected"]:
        raise ReplayFidelityError("protocol choice and historical decision record disagree")
    if recorded_action not in legal_actions:
        raise ReplayFidelityError("recorded action is not part of the historical legal action set")
    request_sha256 = __import__("hashlib").sha256(
        json.dumps(decision_battle.request_json, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    live_records = recorded_live_observations(
        replay.trial_directory / f"private-{replay.actor}" / "decision-bundles.jsonl"
    )
    if live_records:
        try:
            capture = live_records[replay.target_decision_ordinal]
        except IndexError as error:
            raise ReplayFidelityError("live decision capture omits requested ordinal") from error
        if capture["actor"] != replay.actor:
            raise ReplayFidelityError("live capture actor does not match replay actor")
        if capture["requestType"] != decision["requestType"]:
            raise ReplayFidelityError("live capture request type does not match reconstructed request")
        if capture["activeSpecies"] != decision["activeSpecies"]:
            raise ReplayFidelityError("live capture active species does not match reconstructed request")
        if capture["selectedAction"] != recorded_action:
            raise ReplayFidelityError("live capture selected action does not match protocol choice")
        if capture["sourceRequestSha256"] != request_sha256:
            raise ReplayFidelityError("live capture request digest does not match reconstructed request")
        observed = ObservedBattleState(capture["observation"])
        if observed.digest != capture["observationSha256"]:
            raise ReplayFidelityError("live capture observation digest does not match serialized observation")
        if observed.digest != historical["observationDigest"]:
            raise ReplayFidelityError("live capture observation digest does not match historical marker")
    else:
        observed = reconstructed_observed
        if observed.digest != historical["observationDigest"]:
            raise ReplayFidelityError(
                "observation digest mismatch: reconstructed replay does not match the historical input"
            )
    if evidence["turn"] != decision["protocolTurn"]:
        raise ReplayFidelityError("historical evidence turn does not match reconstructed protocol turn")
    return DecisionReplayBundle(
        schema_version=1,
        trial_id=replay.trial_directory.name,
        actor=replay.actor,
        decision_ordinal=replay.target_decision_ordinal,
        protocol_turn=decision["protocolTurn"],
        request_type=decision["requestType"],
        recorded_action=recorded_action,
        legal_search_actions=legal_actions,
        observation_digest=observed.digest,
        observed_state=observed,
        source_request_sha256=request_sha256,
    )


def prepare_recorded_search_position(
    replay: ReplayInput, unavailable_user_species: tuple[str, ...] = ()
) -> tuple[Battle, ObservedBattleState, str]:
    """Build an agent-visible recorded position, optionally changing own public HP.

    The optional mutation is deliberately limited to the acting player's reserve.
    It lets a regression fixture compare the same public position with or without
    a known beneficiary, without reading or changing opponent ground truth.
    """
    bundle = None
    if replay.target_decision_ordinal is None:
        battle, recorded_action = replay_to_turn(replay)
        decision = {
            "decisionOrdinal": None,
            "protocolTurn": battle.turn,
            "requestType": request_type(battle.request_json or {}),
            "recordedAction": recorded_action,
        }
    else:
        bundle = build_decision_replay_bundle(replay)
        battle = bundle.observed_state.reconstruct(StandardBattleMode())
        recorded_action = bundle.recorded_action
        decision = {
            "decisionOrdinal": bundle.decision_ordinal,
            "protocolTurn": bundle.protocol_turn,
            "requestType": bundle.request_type,
            "recordedAction": bundle.recorded_action,
            "historicalLegalActions": list(bundle.legal_search_actions),
        }
    decision_battle = deepcopy(battle)
    if bundle is None and not decision_battle.team_preview:
        decision_battle.user.update_from_request_json(decision_battle.request_json)
    unavailable = {species.lower() for species in unavailable_user_species}
    for pokemon in decision_battle.user.reserve:
        if pokemon.name.lower() in unavailable:
            pokemon.hp = 0
    observed = bundle.observed_state if bundle is not None else ObservedBattleState.capture(decision_battle)
    replayed = observed.reconstruct(battle.mode)
    # Requests are intentionally omitted from the agent projection. Keep a
    # digest in diagnostic metadata instead of reintroducing the private
    # request payload across the observation boundary.
    decision["requestSha256"] = (
        bundle.source_request_sha256
        if bundle is not None
            else __import__("hashlib").sha256(
            json.dumps(decision_battle.request_json, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    replayed.replay_decision = decision
    return replayed, observed, recorded_action


def search_recorded_position(
    replay: ReplayInput, unavailable_user_species: tuple[str, ...] = ()
) -> dict:
    random.seed(replay.seed)
    search_battle, observed, recorded_action = prepare_recorded_search_position(
        replay, unavailable_user_species
    )
    handler = EvidenceCapture()
    root_logger = logging.getLogger()
    previous_level = root_logger.level
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)
    started = time.perf_counter()
    try:
        selected = find_best_move(search_battle)
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000
        root_logger.removeHandler(handler)
        root_logger.setLevel(previous_level)
    return {
        "schemaVersion": 1,
        "input": asdict(replay) | {"trial_directory": str(replay.trial_directory)},
        "fixtureMutation": {
            "unavailableUserSpecies": list(unavailable_user_species),
        },
        "runtime": {
            "beliefEngine": FoulPlayConfig.pdl_belief_engine,
            "actionPolicy": FoulPlayConfig.action_policy,
            "requestedWorlds": replay.requested_worlds,
            "searchMsPerWorld": replay.search_ms,
        },
        "position": {
            "turn": search_battle.turn,
            "recordedAction": recorded_action,
            "decision": getattr(search_battle, "replay_decision", None),
            "observationDigest": observed.digest,
            "active": {
                "user": search_battle.user.active.name if search_battle.user.active else None,
                "opponent": search_battle.opponent.active.name if search_battle.opponent.active else None,
            },
            "publicState": public_position_snapshot(search_battle),
        },
        "selectedAction": selected,
        "wallClockDecisionMs": elapsed_ms,
        "rootEvaluations": handler.root_evaluations,
        "decisionEvidence": handler.decision_evidence,
        "unavailable": {
            "effectiveSearchDepth": "native MCTS binding does not expose depth",
            "transpositionStatistics": "native MCTS binding does not expose transposition counters",
            "leafEvaluatorBreakdowns": "existing instrumentation exposes root, not individual leaf, decompositions",
        },
    }


if __name__ == "__main__":
    try:
        print(json.dumps(search_recorded_position(parse_arguments()), indent=2, sort_keys=True))
    except ReplayFidelityError as error:
        raise SystemExit(f"replay fidelity rejected: {error}")
