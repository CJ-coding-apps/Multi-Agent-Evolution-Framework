# WP-3.7a — the evolver sees its evidence

Branch: `wp/3.7a-evidence` → `wp/phase-3b`

Items 1–2 of the WP-3.7 amendment (2026-11-08). Item 3 — the live row where a failing task
produces a non-`no_op` proposal, with the WP-3.9 K1 row folded in — is the second half and belongs
to `wp/3.7b-evolver`.

## The measured cause

The digester reads `GoldenResult`, `Failure` and `PolicyEvent` nodes from `.maf/memory.kuzu`.
Before this change:

- `GoldenResult` was written in exactly one place, `maf goldens run` (`ScoreRecorder`, wired in
  `commands/goldens.ts`). `maf evolve` paid for a baseline golden run in round 0 and a candidate run
  per evaluated round, and recorded neither.
- No code wrote `PolicyEvent` at all. The digester's query for them could only ever return nothing.
- `digestEvidence` therefore returned an empty digest on a fresh project, the planner prompt said
  `(no golden history)`, and `no_op` was the correct answer to the question it was asked. The round
  note said only `planner returned no_op`, so six live rounds of an empty graph were indistinguishable
  from a planner that chose not to act.

## What changed

### The loop records its own evidence

- **`packages/evolver/src/loop.ts`** — `EvolveOptions.recordGoldens` is the writer; a single
  `evaluate()` wrapper calls `runGoldens` and then the recorder, and both the baseline and the
  candidate run go through it. Recording happens before the next round's digest, so round 0's
  baseline is in round 1's digest. A recorder failure **propagates**: continuing would run blind,
  which is the defect being fixed.
- **`packages/evolver/src/digester.ts`** — `GoldenHistoryRow` carries `failed`, read from the
  recorder's `perTask` rows (`passed === false`). A row written before `perTask` existed parses to
  `failed: []`, so old history stays readable.
- **`packages/evolver/src/planner.ts`** — the one-line summary the planner reads now names what
  failed: `solved 1/2; failed t2`, not just the counts.
- **`packages/cli/src/commands/evolve.ts`** — one `ScoreRecorder` for the run, on the same graph the
  loop digests, so `goldens` and `evolve` write the same evidence in the same shape.

### The policy engine writes `PolicyEvent` nodes

- **`packages/policy-engine/src/PolicyEngine.ts`** — an optional `recorder` (structurally satisfied
  by `MemoryGraph`) receives one `PolicyEvent` per decision, with the tool, the verdict, the reason
  for every verdict but `Allow`, the `ruleId` when the decision has one, the task and the role.
  `evaluate` writes it after tallying, so the event describes the decision that was returned.
  A recorder failure is swallowed: a graph hiccup must not change what policy answered about the
  call in front of it.
- **`packages/policy-engine/src/PolicyLoader.ts`**, **`packages/cli/src/wiring.ts`** — `recorder`
  travels through `PolicyLoadOptions`; `loadCommandPolicy` takes the `MemoryGraph` itself (it used
  to take only its query half) and supplies it. `run`, `goldens` and `evolve` all build their engine
  there, so every governed call in a run writes its decision.

### Empty evidence is said out loud

- **`packages/evolver/src/digester.ts`** — `isEmptyDigest` answers whether nothing a proposal could
  be based on exists (no golden history, failures or policy events).
- **`packages/evolver/src/loop.ts`** — when the planner returns no manifest, the round note is
  `no evidence to propose from` if the digest was empty and `planner returned no_op` if it was not.
  `EvolveOptions.onRound` surfaces every round as it is recorded.
- **`packages/cli/src/commands/evolve.ts`** — `onRound` prints `[maf] round N: <outcome> — <note>`,
  so the sentence reaches the operator's terminal, not only the report file.

## Tests, and the mutant

- `packages/evolver/src/__tests__/evolver.test.ts`
  - **The two-round scripted loop.** A stub graph behaves like the recorder + digester pair (what is
    written as `GoldenResult` reads back newest-first), `recordGoldens` is the real `ScoreRecorder`,
    and the planner captures both prompts. Round 1's prompt matches `(no golden history)`; round 2's
    matches `solved 1/2`, `; failed t2` and the scored harness's sha. The round notes are
    `no evidence to propose from` then `planner returned no_op` — the first because the graph was
    empty before the baseline was run, the second because it was not empty after.
  - **An empty digest is said out loud**, asserted on both `report.rounds[0].note` and the array the
    `onRound` hook (what the CLI prints) received.
  - **A failing recorder stops the run** rather than continuing blind.
  - **Mutant, measured:** deleting the `recordGoldens` call in `evaluate()` turned the suite from
    33/33 to 31/33 — the evidence test failed at *and written through the recorder as evidence*
    (`golden.length` 0, before the prompt assertion), and the propagation test failed with
    *Missing expected rejection*. Restored: 33/33.
- `packages/policy-engine/src/__tests__/policy-events.test.ts` — a deny and an allow each write one
  event with tool, verdict, run, task and role (and the rule and reason for the deny; an allow has
  no reason to record); a recorder that throws leaves the verdict `Deny`; no recorder writes nothing
  and asks nothing of the graph. 115 tests in the package (112 before), 115 pass.
- **End to end, measured once by hand**: a real `PolicyEngine` with a real `MemoryGraph` as its
  recorder, evaluated against a `**/.env` deny, then read back through `digestEvidence`:

  ```
  verdict: Deny | policyEvents: [{"label":"policy Deny fs.write","properties":{"toolId":"fs.write","verdict":"Deny",
  "reason":"secrets off-limits","ruleId":"deny-env","taskId":"task-int"},"runId":"run-int"}]
  ```

## Verification

Measured at `045a13c`, the only commit that changes code.

- `pnpm -r build` and `pnpm -r typecheck` clean on macOS; `grep "error TS"` over both logs = 0.
- **macOS (this host, Node 25.6.0, pnpm 10.34.7), serial suite
  (`pnpm -r --workspace-concurrency=1 test`): 1664 tests, 1662 passed, 2 skipped, 0 failed.** The
  two skips are the package suite's standing pair (ripgrep is not on PATH; the real-adapter LCM
  test). The 1664 is 1658 + the 6 tests added here.
- **Linux (the arbiter): 1664 tests, 1662 passed, 2 skipped, 0 failed.** A `node:22` container over
  a `git archive` of `045a13c` with its own single commit (`9b04a97`), the container's empty store,
  `pnpm install --frozen-lockfile`, `pnpm -r build`, then
  `pnpm -r --no-bail --workspace-concurrency=1 test` (`TEST_RC=0`).
- **The five repository guards, on macOS, all `OK`:** `check:test-scripts` (25/27 declare a test
  script; the two with none are `@maf/blackboard` and `@maf/lcm-adapter`), `check:build-output`
  (27/27), `check:workspace-deps` (27 packages, 94 edges, acyclic), `check:doc-refs`, and
  `check:package` (`36 files, installed and run`, its demo at `goldens solved 4/10` — the baseline,
  unchanged).
- **A first macOS run was red, and not for a reason this branch caused.** The working `dist/` was
  carried over from the `wp/3.15-roles` branch, and five compiled test files from that branch
  remained with no source beside them (`cli`: `committed-default`, `drift-notice-e2e`,
  `harness-show-current`; `roles`: `generator-fieldset`, `one-role-set`, plus
  `defaultRoleSet.generated.js`). They ran here and failed on symbols this branch does not define.
  Removed, rebuilt, and every number above is from the clean run. The same trap is recorded in the
  build notes; `tsc` does not prune `dist/`.

## Not in this lane

- The live row (item 3): a corpus task the base harness fails, a round whose manifest is not
  `no_op` and whose rationale cites that task, the manifest taking the gate's verdict, and the K1
  row folded in with `maf harness set-current <candidateSha>` as the apply step. Written by the
  verifier against `wp/3.7b-evolver`.
- The train/held-out split, the budget enforcement and `maf evolve approve` (D-57's other half).
- No README, CHANGELOG or DECISIONS change is owed by this lane; the new CLI round line is
  described here for WP-3.13's changelog build.
