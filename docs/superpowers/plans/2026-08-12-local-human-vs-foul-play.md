# Local Human vs Foul Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one isolated command that launches a local PDL S4 Showdown battle where a human challenges Foul Play using a supplied six-Pokémon export.

**Architecture:** The command fetches the public read-only roster payload once, freezes it with the existing snapshot adapter, validates the bot’s explicit team against Showdown and its full transaction-projected PDL roster, and exports a full local Foul Play belief file. It then starts the pinned Showdown server and one accepting Foul Play process, retaining all artifacts in a new `/private/tmp` directory.

**Tech Stack:** Node.js/TypeScript, pinned Pokémon Showdown server, Python 3.11 Foul Play, existing PDL snapshot and validation modules.

## Global Constraints

- Do not modify the PDL website, Vercel, Redis, or live league data.
- Read the production roster endpoint exactly once per launched game and retain the frozen result locally.
- The supplied bot team must be an exact standard Showdown export and must be PDL-legal for the selected current roster.
- Use the official Showdown test client connected to the local server; do not add a local client repository.
- Retain bot protocol and process logs under the run directory.

---

### Task 1: Export a complete Foul Play belief from a frozen roster snapshot

**Files:**
- Modify: `pdl/sampling/foul-play-export.ts`
- Test: `test/pdl/sampling/foul-play-export.js`

**Produces:** `buildFoulPlayBeliefForSnapshot(snapshot)` containing every current roster and candidate distribution.

- [ ] Write a failing test with two roster teams and assert both teams and all roster species appear in the returned belief.
- [ ] Run the focused test and verify it fails because the function does not exist.
- [ ] Implement the smallest export using the existing candidate-generation and PDL Tera guardrails.
- [ ] Run the focused test and verify it passes.

### Task 2: Add a testable human-vs-bot command contract

**Files:**
- Create: `pdl/cli/play-bot.ts`
- Create: `test/pdl/cli/play-bot.js`
- Modify: `package.json`

**Produces:** `parsePlayBotArguments`, `buildHumanClientUrl`, and the `pdl:play-bot` package command.

- [ ] Write failing tests for required team ID/file, safe defaults, local output location, and the official client URL targeting the selected port.
- [ ] Run the focused test and verify it fails because the module does not exist.
- [ ] Implement strict argument parsing and pure helpers; reject zero/invalid ports and unsafe output roots.
- [ ] Run the focused test and verify it passes.

### Task 3: Launch and retain the local human-vs-Foul Play session

**Files:**
- Modify: `pdl/cli/play-bot.ts`
- Modify: `README-PDL.md`
- Test: `test/pdl/cli/play-bot.js`

**Produces:** `runPlayBot` that freezes live data, validates the explicit bot team, writes artifacts, starts local processes, waits for bot readiness, prints the official client URL, and cleans up on exit.

- [ ] Write a failing unit test for bot-team validation using a current roster fixture and an out-of-roster Pokémon.
- [ ] Run the focused test and verify it fails because validation is not exported.
- [ ] Implement the launcher with child-process cleanup and no writes outside `/private/tmp`.
- [ ] Run focused tests, TypeScript checking, and Showdown team validation of the supplied Adam export.
- [ ] Update the local simulator README with the exact one-command invocation and browser instructions.
