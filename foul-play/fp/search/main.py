import logging
import json
import math
from hashlib import sha256
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy

from fp.battle.state import Battle
from fp.config import FoulPlayConfig

from poke_engine import (
    State as PokeEngineState,
    monte_carlo_tree_search,
    monte_carlo_tree_search_seeded,
    MctsResult,
    iterative_deepening_expectiminimax,
    IterativeDeepeningResult,
    evaluate_state_breakdown,
    evaluator_metadata,
)

from fp.search.poke_engine_helpers import battle_to_poke_engine_state
from fp.runtime_contract import engine_fingerprint, evaluator_fingerprint

logger = logging.getLogger(__name__)


def apply_pdl_tera_confidence_gate(
    choice: str,
    policy_support: dict[str, float],
    minimum_margin: float | None = None,
) -> str:
    """Require a clear aggregate visit-support edge before a PDL Tera action.

    Values are weighted MCTS policy support, not match-win probabilities.
    """
    if minimum_margin is None:
        minimum_margin = FoulPlayConfig.tera_gate_minimum_support_margin
    if not choice.endswith("-tera"):
        return choice
    tera_support = policy_support.get(choice, 0.0)
    best_non_tera_support = max(
        (support for action, support in policy_support.items() if not action.endswith("-tera")),
        default=0.0,
    )
    margin = tera_support - best_non_tera_support
    logger.info(
        f"PDL Tera gate: action={choice} policy_support={tera_support:.4f} "
        f"best_non_tera_support={best_non_tera_support:.4f} margin={margin:.4f} "
        f"required={minimum_margin:.4f}"
    )
    if margin >= minimum_margin:
        return choice
    # The gate is part of action selection, so a rejected Tera action must fall
    # back to the strongest aggregate non-Tera action. Merely removing the
    # suffix could manufacture a weaker base move while a better switch exists.
    return min(
        (
            (-support, action)
            for action, support in policy_support.items()
            if not action.endswith("-tera")
        ),
        default=(0.0, choice.removesuffix("-tera")),
    )[1]


def select_move_from_mcts_results(
    mcts_results: list[(MctsResult, float, int)],
    pdl_s4: bool = False,
    battle_turn: int | None = None,
    root_evaluations: list[dict] | None = None,
    decision_context: dict | None = None,
    evaluation_metadata: dict | None = None,
    sun_policy: str = "none",
    sun_policy_context: dict | None = None,
) -> str:
    final_policy = {}
    for mcts_result, sample_chance, index in mcts_results:
        this_policy = max(mcts_result.side_one, key=lambda x: x.visits)
        logger.info(
            "Policy {}: {} visited {}% avg_score={} sample_chance_multiplier={}".format(
                index,
                this_policy.move_choice,
                round(100 * this_policy.visits / mcts_result.total_visits, 2),
                round(this_policy.total_score / this_policy.visits, 3),
                round(sample_chance, 3),
            )
        )
        for s1_option in mcts_result.side_one:
            final_policy[s1_option.move_choice] = final_policy.get(
                s1_option.move_choice, 0
            ) + (sample_chance * (s1_option.visits / mcts_result.total_visits))

    policy_support = dict(final_policy)
    native_selected_before_policy = min(
        ((-support, action) for action, support in policy_support.items())
    )[1]
    effective_policy_support = policy_support
    sun_policy_evidence = None
    if sun_policy != "none":
        if sun_policy_context is None:
            raise ValueError("Enabled PDL Sun policy requires public observation context")
        from fp.pdl.sun_policy import apply_sun_policy

        effective_policy_support, sun_policy_evidence = apply_sun_policy(
            sun_policy, sun_policy_context, policy_support
        )
    final_policy = effective_policy_support
    final_policy = sorted(final_policy.items(), key=lambda x: (-x[1], x[0]))

    highest_percentage = final_policy[0][1]
    considered_policy = [i for i in final_policy if i[1] >= highest_percentage * 0.75]
    logger.info("Considered Choices:")
    for i, policy in enumerate(considered_policy):
        logger.info(f"\t{round(policy[1] * 100, 3)}%: {policy[0]}")

    if FoulPlayConfig.action_policy == "stochastic":
        import random

        choice = random.choices(considered_policy, weights=[p[1] for p in considered_policy])[0]
    else:
        choice = final_policy[0]
    selected_before_gate = choice[0]
    selected = apply_pdl_tera_confidence_gate(selected_before_gate, effective_policy_support) if pdl_s4 else selected_before_gate
    if sun_policy_evidence is not None:
        sun_policy_evidence.update({
            "selectedBeforePolicy": native_selected_before_policy,
            "selectedAfterPolicy": selected_before_gate,
            "selectedAfterTeraGate": selected,
        })
    if pdl_s4:
        samples = []
        for world_index, (result, chance, index) in enumerate(mcts_results):
            best = max(result.side_one, key=lambda option: option.visits)
            opponent_options = getattr(result, "side_two", [])
            best_response = (
                max(opponent_options, key=lambda option: option.visits)
                if opponent_options
                else None
            )
            samples.append({
                "index": index,
                "beliefWeight": chance,
                "rootEvaluation": root_evaluations[world_index] if root_evaluations else None,
                "totalVisits": result.total_visits,
                "topAction": best.move_choice,
                "topActionVisits": best.visits,
                "topActionAverageRolloutUtility": best.total_score / best.visits if best.visits else None,
                "actions": [
                    {
                        "action": option.move_choice,
                        "visits": option.visits,
                        "policySupport": option.visits / result.total_visits if result.total_visits else 0.0,
                        "meanRolloutUtility": option.total_score / option.visits if option.visits else None,
                    }
                    for option in result.side_one
                ],
                "topOpponentResponse": None if best_response is None else {
                    "action": best_response.move_choice,
                    "visits": best_response.visits,
                    "policySupport": best_response.visits / result.total_visits if result.total_visits else 0.0,
                    "meanRolloutUtility": best_response.total_score / best_response.visits if best_response.visits else None,
                },
            })
        engine_name, engine_version, evaluator_id = evaluator_metadata()
        evidence_json = json.dumps({
            "turn": battle_turn,
            # Scalars reconstructed from the actor's own request before the
            # request is removed at the observation boundary.  They make a
            # recorded DecisionReplayBundle fail closed on request/actor/
            # ordinal drift without giving the search access to the request.
            **(decision_context or {}),
            "evaluator": {"engine": engine_name, "version": engine_version, "id": evaluator_id, "sourceSha256": evaluator_fingerprint(), "engineSourceSha256": engine_fingerprint()},
            "legalSearchActions": sorted(policy_support),
            "aggregatePolicySupport": policy_support,
            "selectedBeforeTeraGate": selected_before_gate,
            "selected": selected,
            "actionPolicy": FoulPlayConfig.action_policy,
            "teraGateMinimumSupportMargin": FoulPlayConfig.tera_gate_minimum_support_margin,
            "beliefSamples": samples,
            "valueSemantics": "native MCTS mean rollout utility after sigmoid(root-relative evaluator delta); not a raw state score or match-win probability",
            "deterministicEvaluation": evaluation_metadata,
            **({"sunPolicy": sun_policy_evidence} if sun_policy_evidence is not None else {}),
        }, sort_keys=True)
        logger.info(f"PDL_DECISION_EVIDENCE {evidence_json}")
    return selected


def get_result_from_expectiminimax(
    state: str, search_time_ms: int, index: int
) -> IterativeDeepeningResult:
    logger.debug("Calling expectiminimax with %d state: %s", index, state)
    poke_engine_state = PokeEngineState.from_string(state)
    res = iterative_deepening_expectiminimax(poke_engine_state, duration_ms=search_time_ms)
    logger.info(
        "Expectiminimax %d: depth_searched=%d safest_move=%s",
        index,
        res.depth_searched,
        res.get_safest_move(),
    )
    return res


def select_move_from_expectiminimax_results(
    results: list[(IterativeDeepeningResult, float, int)],
    pdl_s4: bool = False,
    battle_turn: int | None = None,
    decision_context: dict | None = None,
) -> str:
    aggregate_scores = {}
    action_counts = {}

    for res, sample_chance, index in results:
        num_s1 = len(res.side_one)
        num_s2 = len(res.side_two)
        logger.info(
            "Expectiminimax %d (weight %.3f): depth=%d safest=%s actions=%d",
            index,
            sample_chance,
            res.depth_searched,
            res.get_safest_move(),
            num_s1,
        )
        for i, s1_act in enumerate(res.side_one):
            scores = []
            for j in range(num_s2):
                val = res.matrix[i * num_s2 + j]
                if not math.isnan(val):
                    scores.append(val)
            min_score = min(scores) if scores else -99999.0
            aggregate_scores[s1_act] = aggregate_scores.get(s1_act, 0.0) + (
                sample_chance * min_score
            )
            action_counts[s1_act] = action_counts.get(s1_act, 0) + 1

    sorted_actions = sorted(aggregate_scores.items(), key=lambda x: x[1], reverse=True)
    logger.info("Minimax Ranked Choices:")
    for act, score in sorted_actions[:6]:
        logger.info("\t%.3f: %s", score, act)

    selected_before_gate = sorted_actions[0][0]
    selected = selected_before_gate

    if pdl_s4 and selected_before_gate.endswith("-tera"):
        best_non_tera = max(
            (score for act, score in sorted_actions if not act.endswith("-tera")),
            default=-99999.0,
        )
        tera_score = aggregate_scores[selected_before_gate]
        margin = tera_score - best_non_tera
        if margin < FoulPlayConfig.tera_gate_minimum_support_margin:
            logger.info(
                "Tera gate: tera score %.3f vs non-tera %.3f (margin %.3f < %.3f), stripping tera",
                tera_score,
                best_non_tera,
                margin,
                FoulPlayConfig.tera_gate_minimum_support_margin,
            )
            selected = selected_before_gate.removesuffix("-tera")
        else:
            logger.info("Tera gate passed: margin %.3f >= %.3f", margin, FoulPlayConfig.tera_gate_minimum_support_margin)

    if pdl_s4:
        samples = [
            {
                "index": index,
                "beliefWeight": chance,
                "depthSearched": res.depth_searched,
                "safestMove": res.get_safest_move(),
            }
            for res, chance, index in results
        ]
        evidence_json = json.dumps(
            {
                "turn": battle_turn,
                **(decision_context or {}),
                "legalSearchActions": sorted(aggregate_scores),
                "aggregateMinimaxScores": {
                    k: round(v, 3) for k, v in aggregate_scores.items()
                },
                "selectedBeforeTeraGate": selected_before_gate,
                "selected": selected,
                "beliefSamples": samples,
                "valueSemantics": "native Rust iterative-deepening expectiminimax minimax value",
            },
            sort_keys=True,
        )
        logger.info(f"PDL_DECISION_EVIDENCE {evidence_json}")

    return selected


def get_result_from_mcts(
    state: str, search_time_ms: int, index: int, threads: int, fixed_iterations: int | None = None, seed: int | None = None
) -> MctsResult:
    logger.debug("Calling with {} state: {}".format(index, state))
    poke_engine_state = PokeEngineState.from_string(state)

    res = (monte_carlo_tree_search_seeded(poke_engine_state, fixed_iterations, seed)
           if fixed_iterations is not None and seed is not None
           else monte_carlo_tree_search(poke_engine_state, search_time_ms, threads=threads))
    logger.info("Iterations {}: {}".format(index, res.total_visits))
    return res


def _evaluation_seed(top_level: str, team_id: str, ordinal: int, subsystem: str) -> int:
    material = f"{top_level}|{team_id}|{ordinal}|{subsystem}".encode("utf-8")
    return int.from_bytes(sha256(material).digest()[:8], "big")


def find_best_move(battle: Battle) -> str:
    battle = deepcopy(battle)
    sun_policy = getattr(FoulPlayConfig, "pdl_sun_policy", "none")
    sun_policy_context = None
    if sun_policy != "none":
        from fp.pdl.sun_policy import capture_sun_policy_context

        sun_policy_context = capture_sun_policy_context(battle)
    if battle.team_preview:
        battle.user.active = battle.user.reserve.pop(0)
        battle.opponent.active = battle.opponent.reserve.pop(0)

    evaluation = FoulPlayConfig.evaluation_fixed_iterations is not None
    ordinal = int(getattr(battle, "turn", 0))
    stable_agent_id = FoulPlayConfig.pdl_team_id or "non-pdl"
    num_battles, search_time_per_battle = battle.mode.search_params(battle)
    if evaluation:
        import random
        # Fixed iteration evaluation uses explicit independent belief/world streams.
        belief_rng = random.Random(_evaluation_seed(FoulPlayConfig.evaluation_belief_seed, stable_agent_id, ordinal, "belief"))
        battles = battle.mode.prepare_battles(battle, num_battles, rng=belief_rng)
    else:
        battles = battle.mode.prepare_battles(battle, num_battles)

    search_inputs = [
        (battle_to_poke_engine_state(b).to_string(), chance, index)
        for index, (b, chance) in enumerate(battles)
    ]
    evaluation_metadata = None
    if evaluation:
        # Canonicalize complete worlds before allocating search.  World order is evidence.
        search_inputs = sorted(search_inputs, key=lambda value: (value[0], value[2]))
        normalized_weight = 1.0 / len(search_inputs) if search_inputs else 0.0
        worlds = [{"index": index, "state": state, "weight": normalized_weight, "fingerprint": sha256(state.encode()).hexdigest()}
                  for index, (state, _chance, _original) in enumerate(search_inputs)]
        digest_payload = json.dumps(worlds, sort_keys=True, separators=(",", ":"))
        evaluation_metadata = {
            "runtime": "pdl-s4-foul-play-eval-fixediter-v1",
            "worldAllocationSeed": _evaluation_seed(FoulPlayConfig.evaluation_world_seed, stable_agent_id, ordinal, "world"),
            "fixedIterations": FoulPlayConfig.evaluation_fixed_iterations,
            "searchThreads": 1, "worldWorkers": 1, "seedScheme": "sha256-v1",
            "worldAllocationDigest": sha256(digest_payload.encode()).hexdigest(),
            "worlds": [{k: v for k, v in world.items() if k != "state"} for world in worlds],
        }
        search_inputs = [(state, normalized_weight, index) for index, (state, _chance, _old) in enumerate(search_inputs)]

    if FoulPlayConfig.search_engine == "expectiminimax":
        logger.info("Searching for a move using native Rust iterative-deepening Expectiminimax...")
        logger.info(
            "Sampling %d belief states at %dms each", num_battles, search_time_per_battle
        )
        if FoulPlayConfig.parallelism == 1:
            em_results = [
                (get_result_from_expectiminimax(state, search_time_per_battle, index), chance, index)
                for state, chance, index in search_inputs
            ]
        else:
            with ProcessPoolExecutor(max_workers=FoulPlayConfig.parallelism) as executor:
                futures = [
                    (
                        executor.submit(
                            get_result_from_expectiminimax,
                            state,
                            search_time_per_battle,
                            index,
                        ),
                        chance,
                        index,
                    )
                    for state, chance, index in search_inputs
                ]
            em_results = [(future.result(), chance, index) for future, chance, index in futures]
        choice = select_move_from_expectiminimax_results(
            em_results,
            battle.format_spec.pdl_s4,
            getattr(battle, "turn", None),
            getattr(battle, "pdl_decision_evidence_context", None),
        )
        logger.info("Choice: {}".format(choice))
        return choice

    logger.info("Searching for a move using MCTS...")
    logger.info(
        "Sampling {} battles at {}ms each".format(num_battles, search_time_per_battle)
    )
    root_evaluations = None
    if battle.format_spec.pdl_s4:
        engine_name, engine_version, evaluator_id = evaluator_metadata()
        root_evaluations = []
        for index, (state, chance, _) in enumerate(search_inputs):
            breakdown = evaluate_state_breakdown(PokeEngineState.from_string(state))
            root_evaluations.append({
                "worldIndex": index,
                "worldFingerprint": sha256(state.encode()).hexdigest(),
                "beliefWeight": chance,
                "evaluator": evaluator_id,
                "evaluatorSourceSha256": evaluator_fingerprint(),
                "engineSourceSha256": engine_fingerprint(),
                "components": {
                    "pokemon": breakdown.pokemon,
                    "hazards": breakdown.hazards,
                    "activeEffects": breakdown.active_effects,
                    "boosts": breakdown.boosts,
                    "tera": breakdown.tera,
                    "sideConditions": breakdown.side_conditions,
                },
                "total": breakdown.total,
            })
        root_evaluations_json = json.dumps({
            "engine": engine_name,
            "version": engine_version,
            "evaluator": evaluator_id,
            "engineSourceSha256": engine_fingerprint(),
            "worlds": root_evaluations,
            "semantics": "native static evaluator score; MCTS rollout utility is sigmoid(evaluate(leaf)-evaluate(root))",
        }, sort_keys=True)
        logger.info(f"PDL_ROOT_EVALUATIONS {root_evaluations_json}")
    if FoulPlayConfig.parallelism == 1:
        if evaluation:
            mcts_results = [
                (
                    get_result_from_mcts(
                        state,
                        search_time_per_battle,
                        index,
                        FoulPlayConfig.search_threads,
                        FoulPlayConfig.evaluation_fixed_iterations,
                        _evaluation_seed(
                            FoulPlayConfig.evaluation_mcts_seed,
                            stable_agent_id,
                            ordinal,
                            f"mcts:{sha256(state.encode()).hexdigest()}",
                        ),
                    ),
                    chance,
                    index,
                )
                for state, chance, index in search_inputs
            ]
        else:
            mcts_results = [
                (
                    get_result_from_mcts(
                        state,
                        search_time_per_battle,
                        index,
                        FoulPlayConfig.search_threads,
                    ),
                    chance,
                    index,
                )
                for state, chance, index in search_inputs
            ]
    else:
        with ProcessPoolExecutor(max_workers=FoulPlayConfig.parallelism) as executor:
            futures = [
                (
                    executor.submit(
                        get_result_from_mcts,
                        state,
                        search_time_per_battle,
                        index,
                        FoulPlayConfig.search_threads,
                    ),
                    chance,
                    index,
                )
                for state, chance, index in search_inputs
            ]
        mcts_results = [(future.result(), chance, index) for future, chance, index in futures]
    choice = select_move_from_mcts_results(
        mcts_results,
        battle.format_spec.pdl_s4,
        getattr(battle, "turn", None),
        root_evaluations,
        getattr(battle, "pdl_decision_evidence_context", None),
        evaluation_metadata,
        sun_policy,
        sun_policy_context,
    )
    logger.info("Choice: {}".format(choice))
    return choice
