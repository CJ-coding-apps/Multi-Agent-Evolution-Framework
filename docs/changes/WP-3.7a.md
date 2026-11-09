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
  candidate run go through it. Recording happens before the planner prompt is built, so round 0's
  baseline is evidence for round 0's own proposal (L1: the digest is re-read after the baseline run;
  before, round 0 planned from the empty digest it had read first). A recorder failure still stops
  the run — see **L2** below for what the caller gets.
- **`packages/evolver/src/digester.ts`** — `GoldenHistoryRow` carries `failed`, read from the
  recorder's `perTask` rows (`passed === false`). A row written before `perTask` existed parses to
  `failed: []`, so old history stays readable.
- **`packages/evolver/src/planner.ts`** — the one-line summary the planner reads now names what
  failed: `solved 1/2; failed t2`, not just the counts.
- **`packages/cli/src/commands/evolve.ts`** — one `ScoreRecorder` for the run, on the same graph the
  loop digests, so `goldens` and `evolve` write the same evidence in the same shape.

### The planner is told which harness is in force (MED-3)

- **`packages/evolver/src/planner.ts`** — `buildPlannerUserPrompt` takes a `CurrentHarnessStatus`
  (id, sha, solved, total, failed). The `Current harness:` line names the loop's own `base`; rows
  for other harnesses are listed under `## Earlier results`, each under the label the loop knows
  for it (R2-L1: `rejected candidate`, `shipped candidate`, `needs-approval candidate`,
  `previous base`, or `earlier result` for a row this loop did not cause), with its own score.
  Before, the line came from the newest golden row, which after a rejected candidate was that
  candidate: the planner was told the harness in force was `default-r1` (3/10) when it was
  `default` (4/10), and a proposal aimed at the wrong baseline. A caller that does not know the
  current harness (an embedder, a test) still gets the newest-row form.
- **`packages/evolver/src/loop.ts`** — `currentStatus` answers from the digest row for `base.sha`,
  else from the baseline this round paid for, else `not scored yet`.

### The policy engine writes `PolicyEvent` nodes

- **`packages/policy-engine/src/PolicyEngine.ts`** — an optional `recorder` (structurally satisfied
  by `MemoryGraph`) receives one `PolicyEvent` per decision **that is evidence**: `Deny`,
  `Escalate` and `Indeterminate`. `Allow` is no longer recorded (MED-2): it is the normal case, one
  per tool call — 62 for two golden runs — and a newest-first digest window full of them pushed the
  one denial a proposal could act on out of the planner's view. The verdict counts in `inForce()`
  remain the complete tally. The event carries the tool, verdict, reason, `ruleId`, task and role;
  an `Escalate` lifts its rule id from `approvalRequest.policyRuleId` (L3). The recorder failure is
  swallowed: a graph hiccup must not change what policy answered about the call in front of it.
- **MED-1, both layers.** A refusal's reason quotes the path it refused and the root it resolved
  against, and this node is read into a model prompt (a real model in WP-3.7b). Every string
  property is masked **at write** with the new `redactEvidenceText` (`@maf/types`): absolute POSIX
  and Windows paths become `[REDACTED:path]`, then the `redactText` credential/assignment tier
  applies. Paths first, so a secret inside a path cannot leave a fragment behind. The digester masks
  **again on read**, because a graph written before this change holds raw reasons. `taskId` is the
  per-dispatch id; `goldenTaskId` (L5) is the corpus task id, so a refusal can be read against the
  score it belongs to.
- **`packages/policy-engine/src/PolicyLoader.ts`**, **`packages/cli/src/wiring.ts`** — `recorder`
  travels through `PolicyLoadOptions`; `loadCommandPolicy` takes the `MemoryGraph` itself (it used
  to take only its query half) and supplies it. `run` and `evolve` build their engine over the
  project's graph, so their refusals reach the digest. **`goldens run` builds the same engine over
  its isolated evaluation graph (D-14)** — its policy events are written there and discarded with
  that directory, and only the score is copied into the project's memory (L4: an earlier sentence
  here claimed `goldens` too; it does not).

### Empty evidence is said out loud

- **`packages/evolver/src/digester.ts`** — `isEmptyDigest` answers whether nothing a proposal could
  be based on exists (no golden history, failures or policy events). Old `Allow` rows cannot
  resurrect an empty digest: the policy query excludes them in the Cypher itself
  (`NOT n.label STARTS WITH 'policy Allow'`, ahead of `LIMIT`), so no number of them can fill the
  newest-first window and starve a denial out of it (R2-L2). A client-side filter remains as a
  backstop for a row written by something other than this engine's `recordEvent`.
- **`packages/evolver/src/loop.ts`** — when the planner returns no manifest, the round note is
  `no evidence to propose from` if the digest was empty and `planner returned no_op` if it was not.
  `EvolveOptions.onRound` surfaces every round as it is recorded.
- **`packages/cli/src/commands/evolve.ts`** — `onRound` prints `[maf] round N: <outcome> — <note>`,
  so the sentence reaches the operator's terminal, not only the report file.

### A paid-for run whose evidence cannot be written still reports (L2)

- **`packages/evolver/src/loop.ts`** — a recorder failure throws a `RecordFailedError` inside the
  loop and comes back as a partial `EvolveReport` (`stopReason: 'record-failed'`, `error`,
  `rounds`), not as a bare graph error. The message says which result was lost and how many rounds
  completed.
- **`packages/cli/src/commands/evolve.ts`** — the stack is closed in a `finally`; the partial report
  is written to `.maf/evolve/<runId>.json`, its path printed, the error printed, and the exit code
  is 1. A run that already paid for rounds keeps them.

## Round 3 — the verifier's second pass

The round-2 verifier confirmed every round-1 MED and LOW in the code and left one MED and five
LOWs. Each is fixed here, and each fix is measured by a test that the old (or a deliberately
planted) defect turns red.

- **R2-MED-1 (the MED-3 test could not fail).** The test gave the base and the candidate the same
  score, so mutant N6 — the `Current harness:` line taking `goldenHistory[0]` again — passed it.
  The candidate now solves nothing (`solved 0/2; failed t1, t2`) against a base at
  `solved 1/2; failed t2`, and the test asserts the whole `Current harness:` line, score and
  failed ids. The newest row can no longer satisfy it by accident. **N6 measured red.**
- **R2-L1 (rows mislabelled).** `loop.ts` keeps a `sha → HistoryLabel` map. A harness it ships is
  `shipped`; the base it replaced is `previous base` (unless this loop shipped it, in which case it
  keeps `shipped`); a candidate it rejects or holds for approval is `rejected` / `needs approval`;
  anything else — another session, another harness — is `earlier result`, the default. A row the
  loop did not cause is never described as a decision it made. **A mutant defaulting every
  unlabelled row to `rejected` is measured red.**
- **R2-L2 (verdict filter in the query).** The `Allow` exclusion moved into the Cypher, ahead of
  `LIMIT`; a test puts 250 allows (12× `failureLimit`) ahead of a denial and reads the denial back.
  **A mutant restoring the post-window client-side filter is measured red.**
- **R2-L3 (path shapes that escaped).** `ABSOLUTE_PATH_PATTERNS` now covers a quoted path with
  spaces (one path, the quotes are the boundary), `C:/…` and `C:\…`, UNC `\\server\share\…`, and a
  path after a colon; the POSIX form refuses a leading `//` so a URL is not read as a path.
  `redactEvidenceText` gained `repoRoots`: an absolute path inside the project is rewritten to its
  repo-relative tail before masking, so the planner can still name the file, and the root alone
  becomes `.`. The project root and its `realpath` are both passed (the confinement refusal quotes
  the resolved one); the pair is cached per root. The separator boundary keeps `/repo-other` from
  being half-rewritten. **A mutant that does not pass the roots is measured red on the policy
  engine's in-root test.**
- **R2-L4 (a recorder failure was untested end to end).** `EvolveDeps.recordGoldens` lets a test
  fail one chosen result. The new CLI test fails the candidate's write, asserts `exitCode === 1`,
  and reads the report on disk: `stopReason: 'record-failed'`, the in-flight round present with
  `outcome: 'record-failed'`, `evaluation.unrecorded: true`, and the candidate's score kept under
  its own sha.
- **R2-L5 (declarations).** `wiring.ts` line 59 is in the PR body, and the two `@maf/types`
  additions are under their own `// WP-3.7a — additive only` header (the re-export is now its own
  `export { … } from` line rather than a name added to an existing list).

## Tests, and the mutants

- `packages/evolver/src/__tests__/evolver.test.ts` (**40 tests**) — the two-round scripted loop now
  asserts that round 1's prompt already carries the score its own baseline paid for (L1) and that
  the round notes are `planner returned no_op`, not `no evidence`, once evidence exists; the L2
  test asserts the `record-failed` report, its message and its empty round list. New: a denial older
  than 62 `Allow` rows still reaches the prompt; an allow-only graph is empty evidence (MED-2); an
  old raw reason is masked on the way out (MED-1); the prompt names `base` with its sha and score
  while the rejected `base-r1` row is listed separately with its own (MED-3). A failing
  `recordRound` still does not abort the loop.
- `packages/policy-engine/src/__tests__/policy-events.test.ts` (**119 tests**) — a denial writes one
  event and an allow writes none; the write-time mask is measured against a real `mkdtemp` root and
  a `ghp_…`-shaped directory in an escaping path (the caller's reason still names it; the stored one
  has `[REDACTED:github-pat]`, no root and no absolute path); an `Escalate` carries
  `ruleId: review-lockfiles`; a golden dispatch carries `goldenTaskId`; a recorder that throws and
  no recorder both leave the verdict alone.
- `packages/types/src/__tests__/redaction.test.ts` (new, **8 tests**) — the path shapes: quoted
  with spaces, `C:/…` and `C:\…`, UNC, after a colon, a URL that is not a path, the in-repo tail
  that survives, the `/repo-other` boundary, and a credential inside a path that leaves no
  fragment.
- `packages/cli/src/__tests__/evolve-records-evidence.test.ts` (**2 tests**) — drives the real
  `registerEvolveCommand(program, { adapters })` through commander with a scripted adapter and one
  corpus task whose script reads `sum.js`, writes a real fix (a writer must change the tree,
  `no_work`), then writes `.env` (denied). It asserts on the round print, the planner prompt, two
  `GoldenResult` rows with two distinct shas (base and `-r1`), and a `Deny` `PolicyEvent` with
  `goldenTaskId: 'coder-sum'` and no `Allow` events.
- **Mutants, each measured and restored (the suite was green again after each):**
  - **M13**, `recordGoldens` removed from `evolve.ts`: the CLI test red at *the baseline and the
    candidate were both recorded* (zero rows).
  - **M14**, the `onRound` print removed: red at *a round line* (only the start and done lines
    remain).
  - **M12**, `recorder: graph` removed from `loadCommandPolicy`: red at *a refused tool call left a
    PolicyEvent behind*.
  - **M3**, the candidate not recorded: red at *the baseline and the candidate were both recorded*
    (one row, round 0 still `reject`).
  - **M5**, the candidate recorded under `baseHarness.sha`: red at *the candidate was recorded under
    its own sha*.
  - **MED-1**, the write-time mask removed: the policy test red at *no credential and no absolute
    path reaches the graph*.
  - **MED-2**, `Allow` events recorded again: the policy test red at *the denial only; allowed calls
    are the tally, not the evidence*.
  - **MED-3**, `current` forced to `undefined`: the evolver test red with the verifier's own failure
    — *names the base: Current harness: base-r1 (…): solved 1/2; failed t1*.
  - **L1**, the post-baseline re-digest removed: the baseline test red on round 0's note.
  - **R3-MED-1 (N6)**, `currentStatus` reading `goldenHistory[0]`: the MED-3 test red on the
    `Current harness:` line (`solved 0/2; failed t1, t2` against the expected `solved 1/2; failed
    t2`).
  - **R3-L1**, unlabelled rows defaulting to `rejected`: the foreign-row test red with `- rejected
    candidate ghost (deadbeefdeadbeef)`.
  - **R3-L2**, the post-window client-side filter only: the starvation test red with
    `0 !== 1` policy events.
  - **R3-L3**, `redactEvidenceText` called without the roots: the policy in-root test red at *the
    file is still nameable* (`cannot write [REDACTED:path]`).

## Verification

Measured at `5307acb`, the last commit that changes code (the fragment commit after it changes
documentation only). The branch also merges `wp/phase-3b` at `64190d3` (WP-3.15, PR #63); the two
`wiring.ts` import edits are both kept, and that merge's tests are part of every number below.

- `pnpm -r build` clean on macOS (0 `error TS`); `pnpm -r typecheck` clean.
- **macOS (this host, Node 25.6.0, pnpm 10.34.7), serial suite
  (`pnpm -r --no-bail --workspace-concurrency=1 test`): 1705 tests, 1703 passed, 2 skipped, 0
  failed, `TEST_RC=0`.** The two skips are the standing pair (ripgrep is not on PATH; the
  real-adapter LCM test). Of the 1705, 21 are added here (evolver 33 → 40, policy-engine 115 →
  119, the CLI end-to-end tests 2, and the new `@maf/types` file 8); the rest of the increase over
  the 1664 recorded at `045a13c` is the merged WP-3.15 lane.
- **Linux (the arbiter): 1705 tests, 1703 passed, 2 skipped, 0 failed, `LINUX_RC=0`.** A `node:22`
  container over a `git archive` of `5307acb` (the tree's own commit `e9c97a5`),
  `npm i -g pnpm@10.34.7`, `pnpm install --frozen-lockfile`, `pnpm -r build`, then
  `pnpm -r --no-bail --workspace-concurrency=1 test` (TAP output; 25 package suites).
- **The five repository guards, on macOS, all `OK`:** `check:test-scripts` (25/27 declare a test
  script; `@maf/blackboard` and `@maf/lcm-adapter` have none), `check:build-output` (27/27),
  `check:workspace-deps` (27 packages, 94 edges, acyclic), `check:doc-refs`, and `check:package`
  (36 files, installed and run; its demo at `goldens solved 4/10`, the baseline).
- The earlier first macOS run of this lane was red because `dist/` had been carried over from
  `wp/3.15-roles` and five orphaned compiled test files ran with no source beside them. They were
  removed; every number above is from a clean build on this branch.

## Not in this lane

- The live row (item 3): a corpus task the base harness fails, a round whose manifest is not
  `no_op` and whose rationale cites that task, the manifest taking the gate's verdict, and the K1
  row folded in with `maf harness set-current <candidateSha>` as the apply step. Written by the
  verifier against `wp/3.7b-evolver`.
- The train/held-out split, the budget enforcement and `maf evolve approve` (D-57's other half).
- No README, CHANGELOG or DECISIONS change is owed by this lane; the new CLI round line is
  described here for WP-3.13's changelog build.
