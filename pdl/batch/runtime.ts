export const CANONICAL_RUNTIME_ID = 'pdl-s4-foul-play-showdown-local-v5';
export const CANONICAL_EVALUATOR_SHA256 = '5c013486e9a07bb04f345518431e648a2884893e8a7acc69991c8a3f8bbde397';
export const CANONICAL_ENGINE_SOURCE_SHA256 = 'c3662dc2f231fca047dc05141f0af8c395d50b43869492dbd56c386d4c2f5eda';
export const CANONICAL_EVALUATOR_ID = 'genx-static-v0.0.48-boost-relevance-v1';

/** Revision identity attached to mechanics artifacts, kept outside the bot runtime contract. */
export const MECHANICS_CONFORMANCE_RUNTIME = Object.freeze({
	baselineTag: 'pdl-hardened-baseline-v1',
	authoritativeEngine: 'pokemon-showdown-local',
	searchEngine: 'poke-engine-mcts',
	// Exact candidate commits are captured by the conformance harness at execution time.
	simulatorRevision: 'captured-at-runtime',
	foulPlayRevision: 'captured-at-runtime',
	pokeEngineRevision: 'captured-at-runtime',
	beliefModelVersion: 'baseline-v1',
	worldAllocationVersion: 'baseline-v1',
	searchConfiguration: 'mcts-argmax',
	evaluator: {id: CANONICAL_EVALUATOR_ID, sourceSha256: CANONICAL_EVALUATOR_SHA256, engineSourceSha256: CANONICAL_ENGINE_SOURCE_SHA256},
});

export const CANONICAL_RUNTIME = Object.freeze({
	id: CANONICAL_RUNTIME_ID,
	authoritativeEngine: 'pokemon-showdown-local',
	agent: 'foul-play',
	searchEngine: 'poke-engine-mcts',
	actionPolicy: 'argmax',
	informationBoundary: 'pdl.observed-battle.v1',
	networkPolicy: 'showdown-loopback-only',
	modelInference: 'forbidden',
	resolvedConfiguration: Object.freeze({ offlineRuntime: true, searchEngine: 'mcts', actionPolicy: 'argmax' }),
	evaluator: Object.freeze({ engine: 'poke-engine', version: '0.0.48', id: CANONICAL_EVALUATOR_ID, sourceSha256: CANONICAL_EVALUATOR_SHA256, engineSourceSha256: CANONICAL_ENGINE_SOURCE_SHA256, feature: 'terastallization' }),
});
