# PDL mechanics conformance

This suite compares the local Pokémon Showdown executor with the exact
instrumented `poke-engine` binding used by the canonical Foul Play runtime. It
does not use a model, a hosted API, or an opponent’s hidden battle state.

Run it from the simulator repository:

```sh
npm run pdl:test-mechanics-conformance
```

The command executes fixed-seed local Showdown fixtures, invokes the local
Foul Play virtual environment and native `poke_engine` extension, runs the
contract tests, and writes `calculations/mechanics-conformance/manifest.json`
plus one JSON file per fixture. Generated reports contain public mechanics
facts only; submitted fixture teams stay in the harness process and are never
written to the report.

## Revision identity

Each result records the frozen baseline tag, candidate revisions for the
simulator, Foul Play, and poke-engine, belief/world versions, search policy,
and evaluator plus complete engine-source hashes. The initial candidate set is
based on:

| Component | Frozen tag / revision |
| --- | --- |
| Simulator | `pdl-hardened-baseline-v1` / `d4608d16` |
| Foul Play | `pdl-hardened-baseline-v1` / `fe9c88f6` |
| poke-engine | `pdl-hardened-baseline-v1` / `19e9b151` |

## Comparison classifications

| Classification | Meaning |
| --- | --- |
| `EXACT` | Both systems expose the same directly comparable result. |
| `SEMANTIC_EQUIVALENT` | Different representations express the same mechanic. |
| `RANGE_COMPATIBLE` | An observed exact value is contained in a validated range. |
| `KNOWN_APPROXIMATION` | The runtime intentionally represents the mechanic less precisely. |
| `UNSUPPORTED` | The probe cannot reconstruct the needed live state yet. |
| `MECHANICS_MISMATCH` | Comparable outputs disagree. This blocks dependent work. |
| `HARNESS_LIMITATION` | The fixture cannot establish the requested property completely. |

Every non-`EXACT` machine report records a reason, possible strategic impact,
possible inference impact, and recommended treatment.

## Current fixture coverage and status

The suite executes public Showdown evidence for ordinary damage, a fixed-seed
damage census, STAB, Terastallization, weather, burn, screens, critical hits,
stat stages, Choice items, Life Orb, Assault Vest, Focus Sash/Sturdy,
hazards/Boots, Rapid Spin, priority, Trick Room, and the PDL-relevant Storm
Drain interaction.

The initial run classifies ordinary damage, STAB, Tera, weather, burn,
screens, stat stages, Choice items, Life Orb, and Assault Vest as
`KNOWN_APPROXIMATION`. The native probe returns maximum normal and critical
damage. Showdown’s fixed-seed outcomes fall inside the derived 85–100% normal
damage envelope, but the binding does **not** expose the sixteen Gen 9 random
damage outcomes or their probability distribution.

The damage-roll census is `HARNESS_LIMITATION`: it samples 64 deterministic
Showdown PRNG seeds and records the observed outcomes, but does not prove that
all reachable Showdown RNG states were enumerated. Critical hit, Focus
Sash/Sturdy, hazards/Boots, Rapid Spin, priority, Trick Room, and Storm Drain
are `UNSUPPORTED` for direct native comparison because the current probe does
not replay the public protocol history into a search state. Their Showdown
fixtures still execute and preserve the public evidence that a future stateful
adapter must consume.

## Consequence for the roadmap

Damage-based posterior updates must remain gated: they cannot claim exact
Showdown roll compatibility from the current native probe. Before Phase 2
uses damage to narrow EV, item, ability, or Tera beliefs, either:

1. expose and validate the full discrete Gen 9 damage distribution in the
   native engine; or
2. explicitly place an authoritative Showdown-compatible calculator behind
   the inference boundary, with conformance tests against Showdown.

Task 1B has completed option 2. The report remains a gate for poke-engine:
no change may treat its max-normal/critical result as an exact likelihood.

## Exact damage likelihoods for inference

`pdl/inference/showdown-damage-likelihood.ts` is an isolated inference source,
not a replacement for the native search transition engine. For a fully
explicit public battle state and a caller-supplied belief hypothesis, it runs
the vendored local Showdown executor once for each Gen 9 random factor from 85
through 100. It uses Showdown's own `Battle#randomizer` integer operation, so
duplicate final values retain their real multiplicities instead of being
derived from maximum damage.

The calculator accepts species, level, IVs, EVs, natures, moves, items,
abilities, Tera, weather, terrain, status, boosts, and screens. Inputs must be
public knowledge or values from the selected belief hypothesis. It accepts
neither a live Foul Play battle object nor a submitted opponent team. Foul Play
uses an explicit JSON stdin/stdout process boundary to invoke it.

`calculations/mechanics-conformance/damage-likelihood.json` records complete
factor-to-damage mappings, unique values, multiplicities, critical state,
source revision, and typed immunity results for ordinary, Tera, weather,
terrain, burn, screens, critical, stat-stage, Choice Specs, Life Orb, Assault
Vest, and Volt Absorb fixtures. Its `EXACT` classification means the result is
directly enumerated by local Showdown; it does **not** change the native
probe's `KNOWN_APPROXIMATION` classification.

Exact-HP observations sum multiplicities for the observed integer loss.
Percentage-only observations enumerate every integer HP state consistent with
Showdown's Gen 7+ `ceil(100 * hp / maxhp)` shared display, including its
damaged-100% → 99% special case, and then sum compatible outcomes. Immunities
are typed as `IMMUNE` with a source such as `ability: Volt Absorb`; no numeric
damage likelihood is supplied for them. Calculator failures are typed as
`CALCULATION_ERROR` and must fail closed.
