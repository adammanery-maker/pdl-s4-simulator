# Generic team search from Terminal

For a new matchup, start with the participant-neutral request format in
`pdl/team-search/matchup-request.schema.json`. The request names the two participants,
their complete draft rosters, two drafted Tera types, exactly two registered Tera
captains, and the team files supplied for this run. Nothing defaults to Adam, Steve,
or a historical submitted team.

The complete example at
`pdl/team-search/examples/aurora-vs-borealis/request.json` can be prepared with:

```bash
npm run pdl:prepare-matchup-search -- \
  --request pdl/team-search/examples/aurora-vs-borealis/request.json \
  --output calculations/aurora-vs-borealis-prepared \
  --preset quick
```

Preparation refuses to overwrite an existing output directory. It writes
`manifest.json`, `belief.json`, and `preparation.json`, prints exact battle counts,
and prints the next dry-run command. Every submitted six is checked with the local
PDL validator before the output is finalized. The compiled manifest pins normalized
team hashes and is consumed by the existing hardened runtime without changing battle
execution, search, evaluation, or action selection. `preparation.json` records the
hypothesis count and legal Tera pool for every species on both full rosters.

The belief file is generated independently from the private team files. It uses the
bundled, versioned public usage catalogue in
`pdl/team-search/data/public-usage-v1.json`, retains observed nature/EV correlations,
and emits bounded complete-set hypotheses for every Pokémon on both full rosters.
All legal native plus drafted Tera types are represented with uniform projection for
registered captains; noncaptains have no Tera hypothesis. The versioned policy keeps
up to 48 complete sets per noncaptain and 192 Tera-projected hypotheses per captain.
It reserves a representative for every retained legal ability/item/nature-EV group,
then fills the remaining slots by products of public component frequencies. Each
group keeps its full generated probability mass when its moveset alternatives are
compressed. Nature and EVs retain their observed pairing; other component
correlations remain an approximation rather than measured complete-set frequencies.
An unusual submitted set therefore does not
become the opponent prior and cannot leak through preparation. The bundled catalogue
records its source hash and bundling date; its original usage period was not present
in the source and is recorded as unknown.

The runtime manifest remains schema v1 for compatibility. Historical keys
`adamCandidates`, `steveOpponents`, `adam`, and `steve` are internal role aliases.
Generic prepared runs record the real mapping in `metadata.roleAliases`, and the
runner propagates it to the resolved manifest, trial metadata, and summaries.

`pdl:team-search` consumes only the candidate and opponent lists in the supplied manifest. There are no default teams, historical opponent scenarios, or one-change ablation restrictions. Battle execution uses the existing `pdl-s4-foul-play-eval-fixediter-v1` runner: 120,000 ordinary native MCTS iterations per sampled world, one Rust thread, serial worlds, deterministic argmax and the existing Tera gate.

A manifest supplies `adamCandidates`, `steveOpponents`, `league` registrations/rosters and `beliefPath`. Each team reference has a stable `id`, human-readable `label`, `teamPath`, normalized `teamHash`, and optional notes/tags/weight. Opponent weights default to one; the unweighted ranking and opponent breakdown are always retained. Captains are registered through league metadata, never inferred from a `Tera Type:` line. Missing captain type annotations resolve to Showdown's native primary type, recorded in the resolved manifest. Source exports are retained unchanged; noncaptain Tera annotations are stripped only from the battle submission.

Prepare teams and league metadata, then validate without launching a battle:

```bash
npm run pdl:team-search -- --manifest /absolute/path/to/search.json --preset quick \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output /absolute/path/to/search-dry-run --dry-run true
```

For A candidates and S supplied opponents, there are `A × S × 2 × N` battles. `quick` uses N=3, `screen-5` 5, `screen` 10, `screen-20` 20 and `confirm` 40. All candidates receive identical top-level battle/search/belief/world seeds within each opponent/orientation/seed-index cell. Later actions may differ as battle states diverge.

Launch (omit `--resume` on the first run; add `--resume true` to the same command when resuming):

```bash
unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
npm run pdl:team-search -- --manifest /absolute/path/to/search.json --preset quick \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" \
  --output /absolute/path/to/search-results
```

Completed clean matching cells are skipped on resume; interrupted/failed attempts are retried under new trial paths. Stale team hashes, prior data or runtime/configuration are rejected. Correct the manifest/output selection rather than mixing runs. Mechanical validation errors stop all execution before the first trial.

Read `summary.json` for ranking and completion, `candidate-results.json` for dynamic opponent/orientation and behavioral details, `cells.jsonl` for aligned seeds/results/provenance, `pairwise.json` for retrospective comparisons and `pathology-candidates.json` for replay review. The pairwise matrix is row-only wins minus column-only wins on shared clean cells; it launches no extra battles. Ties are recorded separately. Small samples are exploratory and do not establish precise matchup probabilities. Team preview remains RED; switching, hazards, Sun, Growth, Memento and Shell Smash remain YELLOW.
