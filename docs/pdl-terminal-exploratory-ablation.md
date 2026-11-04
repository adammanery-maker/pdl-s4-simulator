# Terminal exploratory ablations

These are local, token-free paired full-battle comparisons. Evaluation uses the ordinary native poke-engine MCTS with exactly **120,000 iterations per sampled world**, one Rust thread, serial world evaluation, explicit SHA-256-derived battle/search/belief/world seeds, deterministic argmax, and a local Showdown server.

## Offline preflight

```bash
cd "/Users/amanery/PDL Vercel App/pdl-s4-simulator"
unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
npm run pdl:test-offline-runtime
```

The runner removes model credentials from children, permits only localhost Showdown traffic, and checks both client runtime attestations. Hosted-model calls, external inference calls, and non-local battle-decision network calls are all zero.

## A/A verification

```bash
npm run pdl:explore-ablation -- \
  --manifest pdl/ablation/examples/aa-ablation.json \
  --preset aa \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output calculations/aa-fixed-120k
```

`aa` runs three seeds for every Steve-build/orientation cell (18 paired cells, 36 battles). It requires exact paired terminal results and deterministic action traces. Do not interpret a real screen unless this completes.

## Define and validate one change

Copy `pdl/ablation/examples/demo-ablation.json` and the two exported teams. The manifest validator rejects extra differences. It supports exactly one roster slot, move, item, ability, nature, EV spread, Tera type, or captain-eligibility change.

```bash
npm run pdl:explore-ablation -- --manifest /absolute/path/to/my-comparison.json --preset screen \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output calculations/my-comparison-screen --dry-run true
```

## Real runs

```bash
npm run pdl:explore-ablation -- --manifest /absolute/path/to/my-comparison.json --preset screen \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output calculations/my-comparison-screen
npm run pdl:explore-ablation -- --manifest /absolute/path/to/my-comparison.json --preset screen-20 \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output calculations/my-comparison-screen-20
npm run pdl:explore-ablation -- --manifest /absolute/path/to/my-comparison.json --preset confirm \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output calculations/my-comparison-confirm
```

`quick` is 18 paired cells/36 battles. `screen` is 60 paired cells/120 battles; `screen-20` is 120/240; `confirm` is 240/480. Inspect `summary.json`, `pairs.jsonl`, `pathology-candidates.json`, and each trial’s decision bundle. These results remain exploratory: switching, hazards, Sun, Growth, Memento, and Shell Smash are yellow-trust domains; team preview remains red.
