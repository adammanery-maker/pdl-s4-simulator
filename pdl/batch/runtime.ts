export const CANONICAL_RUNTIME_ID = 'pdl-s4-foul-play-showdown-local-v2';
export const CANONICAL_EVALUATOR_SHA256 = '803e8af501ffc373a018e34adc4a9ef17373067b4e9920b89337c4605559355d';
export const CANONICAL_ENGINE_SOURCE_SHA256 = '7e6f2c0d05c5ccddfb00855cf09b94bce0a3a63840cf584c24cc1875e67b0f42';

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
	evaluator: {id: 'genx-static-v0.0.48', sourceSha256: CANONICAL_EVALUATOR_SHA256, engineSourceSha256: CANONICAL_ENGINE_SOURCE_SHA256},
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
	evaluator: Object.freeze({ engine: 'poke-engine', version: '0.0.48', id: 'genx-static-v0.0.48', sourceSha256: CANONICAL_EVALUATOR_SHA256, engineSourceSha256: CANONICAL_ENGINE_SOURCE_SHA256, feature: 'terastallization' }),
});
