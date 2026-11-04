"""Versioned description and preflight for the canonical local PDL runtime."""

from __future__ import annotations

import hashlib
import json
import sys


RUNTIME_ID = "pdl-s4-foul-play-showdown-local-v5"
OBSERVATION_SCHEMA = "pdl.observed-battle.v1"
EXPECTED_ENGINE = ("poke-engine", "0.0.48", "genx-static-v0.0.48-boost-relevance-v1")
EXPECTED_EVALUATOR_SHA256 = "5c013486e9a07bb04f345518431e648a2884893e8a7acc69991c8a3f8bbde397"
EXPECTED_ENGINE_SOURCE_SHA256 = "c3662dc2f231fca047dc05141f0af8c395d50b43869492dbd56c386d4c2f5eda"
VALID_ENGINE_SOURCE_SHA256S = {
    EXPECTED_ENGINE_SOURCE_SHA256,
    "0dd86e8b2d8485146456b585a19800841bac0f229380fcfd64ea85af3b3bce9b",
    "43762be14db014583c88dbe6e57965928b593e6a65152a77436a52045ed94249",
}


def evaluator_fingerprint() -> str:
    try:
        from poke_engine import evaluator_source
    except ImportError as error:
        raise RuntimeError(
            "Canonical PDL runtime requires an evaluator-source-aware poke-engine build."
        ) from error
    return hashlib.sha256(evaluator_source().encode("utf-8")).hexdigest()


def engine_fingerprint() -> str:
    try:
        from poke_engine import engine_source_sha256
    except ImportError as error:
        raise RuntimeError(
            "Canonical PDL runtime requires a complete-source-attesting poke-engine build."
        ) from error
    return str(engine_source_sha256())


def runtime_contract(config: object | None = None) -> dict[str, object]:
    try:
        from poke_engine import engine_source_sha256, evaluator_metadata, evaluate_state, evaluate_state_breakdown
    except ImportError as error:
        raise RuntimeError(
            "Canonical PDL runtime requires the instrumented local poke-engine v0.0.48 build; "
            "install it from ../poke-engine/poke-engine-py."
        ) from error

    metadata = tuple(evaluator_metadata())
    if metadata != EXPECTED_ENGINE:
        raise RuntimeError(
            f"Unexpected poke-engine evaluator {metadata!r}; expected {EXPECTED_ENGINE!r}."
        )
    if not callable(evaluate_state) or not callable(evaluate_state_breakdown) or not callable(engine_source_sha256):
        raise RuntimeError("Installed poke-engine does not expose its native evaluator instrumentation.")
    fingerprint = evaluator_fingerprint()
    if fingerprint != EXPECTED_EVALUATOR_SHA256:
        raise RuntimeError(
            f"Unexpected poke-engine evaluator source SHA-256 {fingerprint}; "
            f"expected {EXPECTED_EVALUATOR_SHA256}."
        )
    engine_source_fingerprint = engine_fingerprint()
    if engine_source_fingerprint not in VALID_ENGINE_SOURCE_SHA256S:
        raise RuntimeError(
            f"Unexpected poke-engine source SHA-256 {engine_source_fingerprint}; "
            f"expected {EXPECTED_ENGINE_SOURCE_SHA256}."
        )

    offline = True if config is None else bool(getattr(config, "offline_runtime", False))
    search_engine = "mcts" if config is None else str(getattr(config, "search_engine", ""))
    action_policy = "argmax" if config is None else str(getattr(config, "action_policy", ""))

    if config is not None and (not offline or search_engine != "mcts" or action_policy != "argmax"):
        raise RuntimeError(
            "The canonical PDL S4 runtime requires --offline-runtime, "
            "--search-engine mcts, and --action-policy argmax."
        )

    fixed_iterations = None if config is None else getattr(config, "evaluation_fixed_iterations", None)
    resolved_configuration = ({
        "offlineRuntime": offline, "searchEngine": search_engine, "actionPolicy": action_policy,
        "fixedIterations": fixed_iterations, "searchThreads": 1, "seedScheme": "sha256-v1",
    } if fixed_iterations is not None else {
        "offlineRuntime": offline, "searchEngine": search_engine, "actionPolicy": action_policy,
    })
    sun_policy = "none" if config is None else str(getattr(config, "pdl_sun_policy", "none"))
    if sun_policy != "none":
        resolved_configuration.update({
            "sunPolicy": sun_policy,
            "candidateId": str(getattr(config, "pdl_candidate_id", "")),
        })

    return {
        "id": "pdl-s4-foul-play-eval-fixediter-v1" if fixed_iterations is not None else RUNTIME_ID,
        "authoritativeEngine": "pokemon-showdown-local",
        "agent": "foul-play",
        "searchEngine": f"poke-engine-{search_engine}",
        "actionPolicy": action_policy,
        "informationBoundary": OBSERVATION_SCHEMA,
        "networkPolicy": "showdown-loopback-only" if offline else "unrestricted",
        "modelInference": "forbidden",
        "resolvedConfiguration": resolved_configuration,
        "evaluator": {
            "engine": metadata[0],
            "version": metadata[1],
            "id": metadata[2],
            "sourceSha256": fingerprint,
            "engineSourceSha256": engine_source_fingerprint,
            "feature": "terastallization",
            "components": ["pokemon", "hazards", "active_effects", "boosts", "tera", "side_conditions"],
        },
    }


def main() -> None:
    try:
        print(json.dumps(runtime_contract(), sort_keys=True))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
