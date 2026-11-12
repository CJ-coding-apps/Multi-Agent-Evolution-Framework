# WP-3.7b — the yardstick, the budget, and the human's approval

Branch: `wp/3.7b-evolver` → `wp/phase-3b` (created at `6150914`, the merge of PR #64 / WP-3.7a)

WP-3.7's §7 acceptance rows, D-57's train/held-out split and its wall-clock, token and dollar
budgets, and the three round-3 LOWs carried in `~/projects/FIXES-3.7b-carry.md`. Everything below is
proven offline with the scripted adapter. The live row on real `claude` — a failing task, K1
included, `maf harness set-current <sha>` as the apply step — is written by the verifier after a
pass on this branch; it is not claimed here.

## §7, row by row

- **An edit that cannot affect the target role's effective tier is rejected at proposal, with the
  reason.** `gateStatic` gained stage `b-proposal-relevance`: `tune_role_budgets` that sets only
  `maxToolIterations` for a role on the `cli` tier is refused, naming the role and the adapter,
  because the in-process loop's turn cap is never read there. `EvolveOptions.roleTiers` /
  `adapterName` carry the answer; the CLI computes it once with `effectiveTier` from `@maf/roles`
  over `roleSetFromHarness(base.roleSet)` (the branded role set — a harness role's `allowedTools`
  is a plain `string[]`). The candidate cannot change a tier, so the base's map is the candidate's.
  A caller that supplies no map (a test, an embedder) skips the rule rather than guessing a tier.
  Tests: the gate unit test, and `maf evolve` end to end with an adapter that has only `invoke`
  (cli tier) → `rounds[0].gate.stage === 'b-proposal-relevance'`, no critic call.
- **`gateEvaluate` runs before any goldens spend.** The free stages (`gateStatic`, widening) run the
  moment a manifest exists and again on the final one; the smoke test and the golden suite follow.
  The unit test fails a prompt that says "Ignore previous instructions" at
  `b2-instruction-screening`, and the loop test records every `runGoldens` call and finds only the
  baseline's sha there: a refused candidate never reaches the runner. The same shape is asserted
  for an unknown tool id (`b-invariants`) and for a widening that needs approval.
- **`runSmoke` runs the target task, and only a train task.** `smokeCheck` runs the manifest's first
  target task on the candidate. The CLI refuses a task id that is not in the train split before the
  runner is built: a hallucinated id must not spend a held-out task.
- **Sensitive candidates are stored and `maf evolve approve <id>` ships one.** `storeCandidate`
  saves the candidate and leaves CURRENT alone (M1). New `maf evolve approve <candidate>` resolves
  an id or a sha with `HarnessStore.tryLoad`, makes the same single `setCurrent(sha)` write
  `maf harness set-current` makes, prints `[maf] APPROVED <id> (<short>) — now current for this
  project`, and exits 2 for a name it does not have. It builds no adapter and starts no run.
  The working directory is `evolve`'s own `-d`, read with `optsWithGlobals`: commander parses an
  option typed after a subcommand name against the parent's options, so a second `-d` on the
  subcommand would never receive the value.
- **`applyEdit` on an unknown role and graph errors in `digestEvidence` are caught and logged, never
  fatal.** `applyEdit`'s `ManifestError` for a role the harness does not have
  (`role "x" not in harness`) is caught by the loop's free check and becomes a `b-invariants` veto
  carrying that message: the round is rejected and the loop continues. Each digest query runs
  through `readRows`, which pushes `<what>: <message>` into `digest.errors` and returns no rows; the
  loop collects the names in `report.digestErrors` (deduplicated) and keeps proposing from the
  thinner digest. The test drives all four reads — golden history, failures, policy events,
  evolution rounds — one at a time and asserts the failure is reported and the outcome is still
  `no-op`, not a throw.
- **`system-prompt-leak` matches phrases, not the words "print"/"repeat"/"reveal".** The screening
  rule is phrase-shaped: a word boundary on the verb, followed within 20 characters by "your"/"the"
  and the thing asked for ("system prompt", "instructions", "constitution"). A prompt that merely
  contains one of the words is not a leak. A mutant matching the bare words is measured red.
  (`git diff` calls `screening.ts` binary because the file contains a pre-existing raw control
  byte; the change is that one pattern line and its comment.)
- **`add_processor` on an empty bundle starts from the default bundle.**
  `applyEdit` seeds from `DEFAULT_BUNDLE_REFS` (`@maf/processors`) when the base has no bundles,
  because the dispatcher reads an empty list as "use the default bundle": appending to `[]` would
  have replaced `policy-audit`, `secret-redact`, `transcript` and `security-gate` with the one
  processor the edit names.
- **A harness lacking `security-gate` or `secret-redact` for a writer role is rejected.**
  `b-invariants` resolves the effective bundle list (empty ⇒ the default bundle) and refuses a
  non-empty list that leaves a role which can change the tree — any allowed tool at `write` or
  above, an unknown tool counting as `dangerous` — without either processor.
- **`PolicyEvent` nodes are written by the policy engine and `EvolutionRound` nodes are read by the
  digester.** The digester reads `EvolutionRound` (round, outcome, note, harness sha), masks the
  free-text note on the way out like a policy reason, and the planner prompt gained an
  `## Evolution so far` list (`- round N: outcome — note`), so the planner sees the refusal that
  explains a rejected row instead of proposing the same edit again.
- **Candidate ids do not grow unboundedly.** A candidate is `<root>-e<n>`: the root is the base's
  id with any previous counter stripped and capped at 64 characters, and the counter continues from
  the base, so shipping k rounds no longer produces `default-r1-r1-r1…`. The CLI-level tests assert
  the bounded shape (`/-e\d+$/`), not an exact counter.
- **A wall-clock and token budget bound the loop.** See D-57 below.

## D-57: the train/held-out split

- **`packages/eval-harness/src/splits.ts`** (new) — `loadSplits` reads `<corpusRoot>/splits.json`
  and proves it is a partition: `version: 1`, arrays of ids, every id in the corpus, no duplicates,
  disjoint, every corpus task on exactly one side, and both sides non-empty. Each failure names the
  file and the ids. The split is a separate file because `computeCorpusSha` hashes `corpus.json` —
  a new field there would change the sha of every task and invalidate the committed baseline for a
  change that touches no fixture. `computeSplitsSha` is a sha256 over the canonical definition, so
  two different splits never compare.
- **`GoldenRunner`** stamps `split` and `splitsSha` on every result, and a split-scoped runner
  refuses a bare `run()`: without that guard a caller who forgot the ids would measure the whole
  corpus and stamp it `train`, spending a held-out task on the evolver.
- **`ScoreRecorder`** writes `split` and `splits_sha` into the `GoldenResult` row, so a later
  baseline lookup cannot take a full-corpus score for a train score. `baselineFromHistory` and
  `currentStatus` match the row's split as well as its sha.
- **`goldens compare`** refuses two results from different splits, a split result against a
  full-corpus one, and two definitions of the same split name.
- **`packages/cli/src/commands/evolve.ts`** — everything the evolver measures is the train split
  (`runGoldensFor` runs `splits.train` with the split stamp); `runSmoke` refuses a non-train id;
  `runHeldOut` measures the held-out split on a runner stamped `held-out`.
- **`packages/evolver/src/loop.ts`** — after the rounds, `evaluateHeldOut` scores the baseline and
  the survivor **twice each** on the held-out split. `noiseFloor` is the larger of the two
  same-harness disagreements (`symDiff` over the solved ids); `delta` is the survivor's solved
  count minus the baseline's on the first run; `aboveNoiseFloor = delta > noiseFloor` — CJ's gate
  for 0.6.0. The report carries both runs of both harnesses, the numbers and a one-sentence
  `statement`. The held-out results are **never** passed to `recordGoldens`: a held-out task in the
  evidence graph is a task the next round's planner reads. A run that shipped nothing, an exhausted
  budget, a runner error or a runner that measured the wrong split produce `skipped` with the
  reason, never a silent zero.
- **`tests/goldens/splits.json`** (new; identical under `packages/cli/assets/goldens/`) — train 7
  (`coder-sum`, `coder-reverse`, `coder-clamp`, `coder-isodd`, `coder-capitalize`,
  `security-eval-endpoint`, `security-path-traversal`), held-out 3 (`coder-fib`,
  `security-sql-concat`, `review-off-by-one`).

## D-57: the budgets

- **`packages/evolver/src/budget.ts`** (new) — `EvolveBudget` is the meter the caller owns and
  feeds; `snapshot()` answers `exhausted`, the first tripped limit in the order wall-clock, tokens,
  dollars, and the sentence `budget: spent …` / `budget exhausted (<reason>): spent …`. Sub-cent
  money keeps its digits (`$0.001`, not `$0.00`).
- **`packages/evolver/src/loop.ts`** — the budget is asked at the top of every round and again
  immediately before the smoke test and the golden suite. An exhausted run records the round it
  could not start with outcome `budget` and stops with `stopReason: 'budget'`; it does not spend on
  a candidate whose result it would discard, and it does not look patient.
- **`packages/cli/src/commands/evolve.ts`** — `--max-seconds`, `--max-tokens`, `--max-usd` and
  `--usd-per-million-tokens`. A flag that cannot be honoured (not a positive number, or `--max-usd`
  without a price) is refused with exit 2 before anything is opened or paid for. `meterTokens`
  charges the meta-agent's calls and every role dispatch: a backend-reported `tokensUsed` is
  trusted, otherwise characters/4 is the estimate, and the statement at the end says which.
  The report and the terminal print both the budget statement and the held-out statement.

## Round-3 LOWs carried onto this branch

- **R3-L1 — a `needs-approval` candidate is labelled as such in the next planner prompt.** The
  history label map answers `needs-approval candidate` for a held row (and `rejected candidate` for
  a vetoed one); the prompt test asserts the label and its score. **A mutant that labels the held
  row `rejected` is measured red.**
- **R3-L2 — an unquoted path with spaces is masked whole.** The unquoted absolute-path regex now
  continues past the first segment over space-separated tokens that still contain a separator, so
  `/Users/a b/secret.txt` and `C:\Program Files\x\key.pem` are masked completely and nothing after
  the space survives; a token with no separator is prose and ends the path. The repo-relative tail
  rule (an absolute path inside the project becomes its relative tail before masking) still holds,
  and its test still passes. **A mutant restoring the stop-at-the-first-space regex is measured
  red.**
- **R3-L3 — a failed baseline write keeps the baseline's own scores.** `RecordFailedError` carries
  the measured `GoldenSuiteResult`; the baseline call site passes it to `recordFailureReport`,
  which puts it in the partial report as `unrecordedBaseline { harnessId, harnessSha, scores,
  unrecorded: true }` and says so in `error`. A candidate's failure still keeps its scores in the
  round's `evaluation`, as before — there is no double copy. **A mutant dropping the baseline
  scores from the partial report is measured red.**

## The offline rows (scripted adapter, no model in the loop)

`scripted.json` gained an `evolution` block — one planner answer and one critic answer, the last
repeating — and `coder-fib` gained a second script marked `systemContains: "thorough"`. The
scripted adapter classifies the evolver's own calls by their system prompts, prefers the marked
variant the role prompt matches (file order does not decide it), and repeats the last evolution
answer once the list is spent, so a run of any length is a pure function of the file. Both copies
of the asset (`tests/goldens/` and `packages/cli/assets/goldens/`) are byte-identical.

1. **Value row — the survivor beats the baseline on the held-out split.** Each row below was run in
   a fresh scratch repository (`git init`, one commit, `maf init`) with
   `--corpus tests/goldens --rounds 3 --patience 2`.
   > `[maf] SHIP legacy-default-e2 (40af1358) — improves coder-capitalize`
   > `[maf] round 1: reject — e-improvement: no golden-suite improvement`
   > `[maf] evolve done: ships=1 stop=patience → …/.maf/evolve/<runId>.json`
   > `[maf] budget: spent 51.9s of 20.0m wall-clock, 23045 of 400000 tokens, $0.07 of $5.00`
   > `[maf] held-out: baseline solved 0/3 then 0/3; candidate solved 1/3 then 1/3; delta +1 against a noise floor of 0 (each harness scored 2 times) — above the noise floor`

   The shipped candidate is the prompt edit the train split rewarded (`coder-capitalize`); the
   held-out improvement is `coder-fib`'s marked variant answering the evolved prompt. That is the
   wiring proven, not the model — `scripted.json` says so in its own note. The same input produced
   the same candidate sha (`40af1358`) and the same numbers as the earlier measurement.
2. **Token row — `--max-tokens 2000`.**
   > `[maf] round 0: budget — budget exhausted (tokens): spent 5939 of 2000 tokens`
   > `[maf] evolve done: ships=0 stop=budget`
   > `[maf] held-out: not scored — no candidate shipped, so there is no survivor to score on the held-out split`
3. **Dollar row — `--max-usd 0.001 --usd-per-million-tokens 3`.**
   > `[maf] round 0: budget — budget exhausted (usd): spent $0.02 of $0.001`
4. **Wall-clock row — `--max-seconds 1`.**
   > `[maf] round 0: budget — budget exhausted (wall-clock): spent 9.3s of 1.0s wall-clock`

   Rows 2–4 each paid for the round-0 baseline before the ceiling was reached — the baseline is
   the first paid golden run and its cost is unknown until it runs — so the run records the round
   it could not continue and starts nothing after it; **no candidate goldens were spent**. (An
   earlier version of this paragraph said "no goldens were spent", which was false: the numbers in
   row 2 are the baseline's own spend.) Row 1 ran to patience. Each report on disk carries the
   same `budget` and `heldOut` blocks that the terminal printed.

## Tests, and the mutants

- `packages/evolver/src/__tests__/evolver.test.ts` (**56 tests**, up from 40 at the WP-3.7a
  fragment) — the gate stages (tier reach, writer processors, default bundle), the digest reads
  (all four, non-fatal, deduplicated), bounded candidate ids, the budget meter and its statements,
  the held-out noise floor and delta (`>` not `>=`), the held-out skip reasons, the R3-L1 label map,
  the R3-L3 partial report, and the evolution-round prompt list.
- `packages/eval-harness/src/__tests__/splits.test.ts` (new, **3 tests**) — a valid partition; each
  refusal names its defect (unknown id, both sides, duplicate, omitted task, empty side, missing or
  malformed file); the sha is stable across key order.
- `packages/eval-harness/src/__tests__/scripted-adapter.test.ts` (**10 tests**) — the marked variant
  wins regardless of file order, an unmatched marker falls back to the unmarked script and never to
  silence, the in-process tier answers the same way, duplicate markers are refused, and evolution
  answers run in order and then repeat.
- `packages/types/src/__tests__/redaction.test.ts` (**11 tests**) — the R3-L2 shapes: a quoted path
  with spaces, an unquoted POSIX path with spaces, `C:\Program Files\…`, the repo-relative tail, the
  `/repo-other` boundary and a credential inside a path.
- `packages/cli/src/__tests__/eval-commands.test.ts` (**8 tests**) — the §7 tier refusal end to end,
  `maf evolve approve` (applies a stored candidate, refuses an unknown one, builds no adapter), and
  the existing round-2/3 rows.
- `packages/cli/src/__tests__/evolve-records-evidence.test.ts` (**2 tests**) — the corpus now has a
  train task and a held-out task with their own fixture copies and a `splits.json`; MED-4 asserts
  the bounded id.
- `packages/cli/src/__tests__/goldens-offline.test.ts` — `goldens compare` refuses different splits
  and different split definitions.
- **Mutants, each measured red and the suite green again after restore:** the CLI tier wiring
  removed; the screening phrase rule replaced by the bare words; `add_processor` appending to the
  empty list; the writer-processor rule removed; the `b-proposal` rule made unreachable; the
  `EvolutionRound` read removed; the candidate-id counter replaced by the unbounded `-r<n>`; the
  split-scoped runner guard removed; a split side allowed to be empty; an omitted task allowed; the
  held-out comparison `>` relaxed to `>=`; a held-out result passed to `recordGoldens`; the smoke
  budget check moved after the smoke run; the scripted variant preference removed (file order
  decides); the evolution answer list not repeating; the digester guard scoped to one read; the R3-L1
  held row labelled `rejected`; the R3-L3 baseline scores dropped; the R3-L2 old path regex; and
  `evolve approve` not refusing an unknown candidate.

## Verification

- **macOS (Darwin 24.5.0), the recorded serial form** — `pnpm -r --no-bail
  --workspace-concurrency=1 test` at code commit `6201ddb`: **1734 tests, 1732 pass, 2 skipped,
  0 fail** (`TEST_RC=0`), across the 25 packages that declare a test script. An earlier
  default-concurrency `pnpm -r test` run interleaved the packages; it is not the record and was
  replaced by this form.
- **Linux (node 22.23.4, `node:22` container)** — `pnpm install --frozen-lockfile`, `pnpm -r
  build`, then the same serial command over a `git archive` of `6201ddb`: `BUILD_OK`, **1734
  tests, 1732 pass, 2 skipped, 0 fail**, `LINUX_RC=0`, zero failure lines. The two hosts agree on
  every count; the container's reporter renders the summary marker as ASCII `#`, which is the only
  difference in the logs.
- **Guards** — `check:test-scripts` 25 of 27 packages declare a test script (none for
  `@maf/blackboard`, `@maf/lcm-adapter`); `check:build-output` 27/27; `check:workspace-deps` 27
  packages, 95 internal edges, acyclic (94 before the new `@maf/evolver` → `@maf/processors`
  link); `check:doc-refs` OK; `check:package` 37 files, installed and run, `goldens solved 4/10`.
- **The offline rows above** were re-measured on this build from fresh scratch repositories; each
  exited 0 and printed the quoted lines.
- **The mutants** were each applied to the compiled `dist/`, observed red, and reversed; the suite
  is green on the restored tree.

## Not in this lane

- **The live row, and the verifier pass before any paid run.** A corpus task the base fails, a round
  whose manifest is not `no_op` and whose rationale cites that task, the manifest taking the gate's
  verdict, K1 folded in, applied with `maf harness set-current <sha>`, on real `claude`. The
  scripted rows above prove the wiring; they are not evidence about a model.
- No `CHANGELOG.md`, README status table or `docs/DECISIONS.md` change is owed by this lane; the new
  commands and statements are described here for WP-3.13's changelog build.
- `@maf/evolver` gains a `workspace:*` dependency on `@maf/processors` (for the default bundle
  reference). There is no cycle; the lockfile diff is only that importer.
