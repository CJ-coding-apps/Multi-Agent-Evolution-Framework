# WP-3.2 — LCM built properly (D-17)

Branch: `wp/3.2-lcm` → `wp/phase-3b`

## What this changes

D-17 asked for an LCM whose summaries are produced by the run's own backend, with a
configurable model, and whose compaction drops exactly what it summarized. Before this WP the
engine's `summarize` hook was a local stub in every caller (`messages.map(m => m.content.slice(0,
200)).join('\n')`), the transcript fed LCM compaction ids it had never stored, and both failures
were swallowed.

### Summaries come from the adapter (D-17)

- **`packages/lcm/src/AdapterSummarizer.ts`** (new) — `createAdapterSummarizer` and
  `createAdapterSubAgent` back the engine with the run's `CliAdapter`. Both invoke with
  `nativeTools: false` (a summarization call must not be able to act on the tree), a default
  120 s timeout, and the configured model when one is given. A failed call, an empty reply, or an
  empty message list throws; nothing invents a summary. The sub-agent call refuses an empty reply
  for the same reason as the summarizer: an empty Agentic-Map summary would replace messages it
  was asked to preserve.
- **`packages/lcm/src/summarizer.ts`** (new) — `SummaryOutput = string | {content, tokensUsed?}`,
  `summaryContent`, `summaryTokens` (the backend's finite, non-negative `tokensUsed`; otherwise
  the 4-chars-per-token estimate), `estimateTokens`.
- **`packages/cli/src/commands/run.ts`** — the run wires `createAdapterSummarizer` /
  `createAdapterSubAgent` with the run's adapter and `summarizerModelFor(cfg)`.
  `lcm.model` chooses the model for summarization alone; absent, `--model` / `model`; absent,
  the adapter's own.
- **`packages/cli/src/wiring.ts`** — `buildRunStack` (goldens, the in-process demo, evolve) uses
  the same wiring, replacing its own copy of the stub.
- **`packages/cli/src/main.ts`** — `merge-runs`' summarizer now throws
  (`merge-runs does not summarize: supply an adapter-backed summarizer to compact.`) instead of
  fabricating text. `merge-runs` never assembles a context, so it never summarizes.
- **`packages/cli/src/config/ConfigLoader.ts`** — `lcm.model` is a typed config field: resolved
  (`flags.lcm.model ?? file.lcm.model ?? defaults.lcm.model`), read from `config.yaml` with the
  "a non-empty model name" rule, and in `LCM_FIELDS` so an unknown key is still rejected.

### Compaction summarizes exactly what it drops (D-17)

- **`packages/transcript/src/TranscriptLogger.ts`** — `append` keeps the id `lcm.addMessage`
  returns and passes `(entry, messageId)` to a `CompressionAgent`. It no longer holds a second,
  divergent copy of the pending list and no longer compacts with transcript-entry ids. New
  `compactNow()`, `getTotalTokens()`, `getEntries()`; `onCompactionError` replaces
  `.catch(() => undefined)`; the default reporter warns.
- **`packages/transcript/src/CompressionAgent.ts`** — the `as never[]` cast is gone. `ingest`
  starts a `drain()` loop guarded by `inFlight`; the loop repeats until the threshold is met or
  the queue is empty, so entries appended during a pass are not stranded. A failure rejects out,
  is reported through `onError`, and leaves the entries in place. `idle()` awaits a pass in
  flight.
- **`packages/lcm/src/LcmEngine.ts`** — `summarizeChunk` refuses an empty chunk and refuses ids
  the store does not hold (naming up to three), rather than summarizing fewer messages than it
  will drop. `assembleContext` keeps the newest `freshTailCount` raw, summarizes exactly the
  uncompacted messages older than the tail, and counts fresh messages, summaries and ghost cues
  against `tokenBudget`, so the budget is a ceiling. `Dolt` mode returns ghost cues; `Upward`
  mode returns the summaries themselves (`LcmContext.summaries`).
- **`packages/lcm/src/LcmStore.ts`** — `getMessagesByIds` reads a segment chronologically
  (`created_at ASC, rowid ASC`); `getFreshTail` returns the newest N, oldest first;
  `getUncompactedMessages` applies the fresh-tail exclusion to uncompacted rows;
  `getMessagesBySession` loses its `limit` parameter, which answered "the oldest N" and was used
  as the fresh tail.
- **`packages/lcm/src/operators/{LlmMap,AgenticMap}.ts`** — use the shared `SummaryOutput`
  helpers so the backend's token count is used where it exists.
- **`packages/lcm/src/GhostCueBuilder.ts`** — `buildWithContent` takes and ranks the newest
  summaries; the previous version took the oldest ten and dropped the newest.
- **`packages/lcm/src/index.ts`** — exports the new helpers.
- **`packages/types/src/index.ts`** — `LcmContext.summaries?: LcmSummary[]`, optional and
  additive (a consumer written against 0.5.0 is unaffected).

### The injector renders Upward mode

- **`packages/prompt-injector/src/GraphAwareInjector.ts`** — renders `ctx.summaries` as
  `<summary id=… level=… tokens=…>` entries, and escapes cue and summary text on the way into
  the prompt (summary text is data from an earlier model, not markup). The escaper is a single
  pass over the five XML metacharacters, shaped so it does not match memory-graph's repo-wide
  `no-escaper` rule (which cannot distinguish XML escaping from Cypher quote doubling).

### Test scripts

`packages/lcm`, `packages/transcript` and `packages/prompt-injector` gain
`"test": "node --test dist/__tests__/*.test.js"`, so the new tests run under `pnpm -r test` and
under the `check:test-scripts` guard.

## The verifier round (D-52)

The first PR for this WP was not mergeable: the tests passed and LCM still did not work in a real
run. D-52 records the choices below and the alternatives rejected for each. The findings are the
verifier's F1–F14; `F15` belonged to WP-3.8 (#51).

### F1 — a summary is a recorded, budgeted model call

- **`packages/types/src/index.ts`** — `LcmSummarySurface` (summary id, level, messages, chars,
  content and reported tokens, and the model surface's digests) and `LcmTrigger` (`taskId`,
  `nodeId`); `LcmContext.summaryCalls`, `compactionTokens`, `degraded`.
- **`packages/lcm/src/LcmEngine.ts`** — every summary call, at every level, goes through
  `recordCall` and the caller-supplied `recordSummaryCall`. The engine reports what the backend
  said (`tokensUsed`, `modelSurface`, model); it does not invent a surface.
- **`packages/lcm/src/{operators/AgenticMap,AdapterSummarizer}.ts`** — the sub-agent seam returns
  `SummaryOutput`, not a bare string. Without that the Agentic-Map operator discarded the
  backend's tokens and surface, so nothing was recorded — the defect this round's wiring test
  found.
- **`packages/cli/src/wiring.ts`** — `recordSummaryCall` writes `kind:'lcm-summary'`,
  `role:'lcm'`, `nativeTools:'none'`, attributed to the triggering node/task (session alone for a
  background pass).
- **`packages/roles/src/RoleDispatcher.ts`** — writes one `[surface] lcm summary …` transcript
  line per call and subtracts what the call spent (`reportedTokens ?? contentTokens`) from the
  node's `tokenBudget`, so the loop's own budget check includes it.

### F2 — the injector's budget covers what the injector renders

- **`packages/prompt-injector/src/GraphAwareInjector.ts`** — the archive is assembled first and
  gets its budget before the graph; the raw fresh tail is not rendered and is not charged. The
  previous order charged messages the injector never wrote, so a summary could be dropped for room
  after the node had already paid for it.
- **`packages/lcm/src/LcmEngine.ts`** — a message is kept raw or summarized then dropped, never
  dropped unsummarized. A failed compaction (F5) returns every uncompacted message.

### F3 — the run-level wiring is proven; the operator is real

- **`packages/cli/src/__tests__/run-lcm-wiring.test.ts`** (new) — drives `buildRunStack` and
  `RoleDispatcher` with a scripted adapter past the threshold, and asserts the summarization
  invoke (configured model, `nativeTools:false`), the summary in the next node's system prompt,
  the bundle record, and the charged budget. It kills M6, M7, M12 and M21.
- **`lcm.operator: llm-map | agentic-map`** — config field, validator and `buildRunStack` wiring.
  `agentic-map` reaches `AgenticMap`; a missing `runSubAgent` is an error, never a silent
  downgrade.
- **`packages/lcm/src/SessionMerger.ts`** — a merge re-links each shared summary to the copied
  messages' new ids, so the target session sees the archive its messages point at.

### F4 — every summarization call is bounded

- **`packages/lcm/src/LcmEngine.ts`** — messages are split into units at
  `MAX_SUMMARY_PROMPT_CHARS` (64 KiB, half of Linux's 128 KiB single-argument limit), packed into
  groups that fit one call, and each group is summarized separately; level-0 chunks are then
  summarized upward. The test sends 70 × 64,000-character messages and asserts no call exceeds
  the cap.

### F5 — a failed compaction degrades, and says so

- **`packages/lcm/src/LcmEngine.ts`** — only a `TransportError` is retried (`summaryRetry`,
  default one extra attempt); a verdict is not. After the retries the assembly continues
  uncompacted.
- **`packages/types/src/index.ts`, `packages/attestation/src/Attestor.ts`** — `LcmDegradedRecord`;
  `Attestor.recordLcmDegraded`; `bundle().lcmDegraded` only when non-empty.
- **`packages/roles/src/RoleDispatcher.ts`** — `[lcm] compaction failed: <reason>; continuing
  uncompacted` on the transcript.
- **`lcm.summaryTimeoutMs`** — the timeout was a constant in two places (`120_000`); it is a
  config key.

### F6 — one compaction per session, no double coverage

- **`packages/lcm/src/LcmEngine.ts`** — a per-session lock serializes compaction, and
  `compactLocked` re-reads under the lock and skips ids whose `summary_id` is already set. Shared
  by `CompressionAgent` and `assembleContext`; at `maxConcurrent: 4` the test sees one call and
  each message in exactly one summary.

### F7 — credentials are masked into and out of LCM

- **`packages/lcm/src/LcmEngine.ts`** — `addMessage` redacts before storing; the summarizer input
  is redacted at the one place every prompt passes through; the summary output is redacted before
  it is stored. The test drives a fake key through `addMessage` → summary → injected prompt and
  finds it nowhere.

### F8 — `lcm.expand` makes the Dolt cue true

- **`packages/tools/src/plugins/lcm.ts`** (new), `packages/tools/src/index.ts`,
  `packages/roles/src/defaults.ts`, `.maf/roles.yaml` (and the packaged copy) — a read-only,
  pathless tool returning the summary text and its masked source messages, in every role's
  registry. The Dolt cue names it, so it has to exist. A registry without an archive refuses with
  that reason rather than claiming the id is unknown.

### F9 — hierarchical compaction

- **`packages/lcm/src/LcmEngine.ts`** — after level 0, `raise` summarizes children into level+1
  summaries that name their `parentIds` and link every descendant message, until one root covers
  the segment. Nothing is dropped without an ancestor covering it; `lcm.expand` on the root
  recovers the whole segment.

### F10 and F11 — token semantics and the live test

- **`packages/lcm/src/LcmEngine.ts`** — a summary's stored context size is the content's own
  estimate; what the backend reported goes on the call's record. They answer different questions.
- **`packages/cli/src/__tests__/lcm-live.test.ts`** — a near-zero `contextThreshold` forces
  compaction while a 4096-token budget leaves room, and the test asserts the summary is in
  `lcm_summaries` and reachable through `expandSummary`, not merely present in a tight context.

### F12–F14 — settings, `off`, and this record

- **`packages/cli/src/wiring.ts`** — `buildRunStack` takes the resolved `lcm` settings (mode,
  threshold, tail, model, operator, timeout) instead of hard-coding them.
- **`packages/types/src/index.ts`, `ConfigLoader.ts`** — `LcmMode` gains `off`; no compaction,
  no summaries, no cues, and the mode is recorded rather than unexplained.
- This document + D-52; the D-26 citations that named the merge-policy rule for LCM defects are
  replaced with D-17 (mechanism) and D-52 (choices).

## Files outside the spec's list, and why

- **`packages/cli/src/config/ConfigLoader.ts`** — the spec named the config keys but not the
  loader. `lcm.model`, `lcm.operator`, `lcm.summaryTimeoutMs` and `lcm.mode: off` are read,
  validated by name and in `LCM_FIELDS`, because a key that is accepted but unread is how the
  section became inert before.
- **`packages/cli/src/main.ts`** — `merge-runs`' summarizer throws instead of fabricating text.
  `merge-runs` never assembles a context, so it never summarizes; the placeholder was dead code
  that could have become a false summary if that changed.
- **`packages/cli/src/commands/run.ts` (`summarizerModelFor`)** — resolves the summary model
  (`lcm.model` → run model → adapter's own) in one place shared by `run`, `goldens` and `evolve`.
- **`packages/cli/src/__tests__/approval-gate-stack.test.ts`** — the test now creates
  `mafDir` explicitly. `buildRunStack`'s contract is that the caller creates it (`run` and
  `goldens` call `ensureMafDir`); the test passed only because Kùzu **0.7.1** creates a missing
  parent directory as a side effect of a schema query. Measured: `new Database(<missing parent>)`
  then a query creates it on 0.7.1 and fails on 0.11.3. Creating it makes the test prove the
  stack, not a library's side effect. This file is not WP-3.2's, and WP-3.8 (0.11.3) needs the
  same change; it is declared here because the WP-3.2 lane measured the behaviour.

### Harness re-mint

The default harness is re-minted because the role set changed (F8 adds `lcm.expand` to every
role): `7e0a5503…` → `0f4a05eb…`. The old file is removed from `.maf/harnesses/` and
`packages/cli/assets/harnesses/`; the goldens baselines are regenerated with the new id.

## Findings recorded, not fixed

These belong to other WPs; none is changed by this branch.

1. **`MemoryGraph.initSchema` swallows schema errors** (`catch { /* ignore already-exists */ }`).
   On Kùzu 0.11.3 a missing `mafDir` makes every DDL query fail with
   `IO exception: Cannot open file … No such file or directory`, and the graph is left silently
   schema-less. On 0.11.3 the failure is no longer masked by 0.7.1's directory side effect.
   WP-3.8 should either create the directory or stop swallowing a non-"already exists" error.
2. **`maf evolve` never calls `ensureMafDir`** (`packages/cli/src/commands/evolve.ts`:
   `const mafDir = path.join(cwd, '.maf')`, then `new HarnessStore(mafDir)` and `buildRunStack`),
   unlike `run` and `goldens`. On 0.11.3 that reaches finding 1.
3. **Base branch CI is red** on `origin/wp/phase-3b` @ `35e1f32`, on a test this branch does not
   touch: `not ok 175 - a stack whose policy cannot be resolved closes the graph it opened (M1)`,
   `ENOTEMPTY: directory not empty, rmdir '…/state/memory.kuzu'`. It passes locally on this
   branch (the same test, 169 ms). Reported, not repaired from this lane.

## Verification

On `wp/3.2-lcm`, after the final edit:

| Gate | Result |
|---|---|
| `pnpm -r build` | exit 0 |
| `pnpm run check:build-output` | exit 0 |
| `pnpm run check:test-scripts` | exit 0 |
| `pnpm run check:workspace-deps` | exit 0 |
| `pnpm run check:doc-refs` | exit 0 |
| `pnpm -r typecheck` | exit 0, `error TS` = 0 |
| `pnpm -r test` | exit 0 — **1088 tests, 1086 pass, 0 fail, 2 skipped** |

The two skips are `lcm-live` (needs `MAF_LIVE_SUMMARIZATION=1` and a real adapter; it is not run
as part of the suite) and one pre-existing skip in `@maf/tools`.

New/expanded tests: `lcm/src/__tests__/adapter-summarizer.test.ts`,
`lcm/src/__tests__/lcm-engine.test.ts`,
`prompt-injector/src/__tests__/injector.test.ts`,
`transcript/src/__tests__/transcript-logger.test.ts`, `cli/src/__tests__/lcm-config.test.ts`,
`cli/src/__tests__/run-lcm-wiring.test.ts` (F1–F5, F12, F14 through the real stack),
`tools/src/__tests__/lcm-expand.test.ts` (F8), and the env-gated
`cli/src/__tests__/lcm-live.test.ts` (F11).

## Live rows

Not written by this lane. The spec assigns LCM's live rows to a fresh verifier, written before
this code.

## Size, and why this PR cannot be split now

D-26 asks for small, package-confined PRs. This one is far over that: the engine change (F1–F7,
F9–F11) is one behaviour — a summary is a recorded, budgeted, bounded, masked model call whose
failure degrades — and every one of those parts is observable only through the others. A PR that
recorded summary calls without charging them would produce a bundle that overstates a node's
budget; one that bounded calls without hierarchical parents would drop context; one that masked
input without masking output would store the credential it was asked not to. F2, F3, F5, F8 and
F12 reach outside `@maf/lcm` because the wiring and the injector are where the engine's contract
becomes observable in a run. Splitting along file boundaries would therefore split one tested
claim into several untested ones, which is the failure this round's verdict found in the first
place. The split that is possible — the Kùzu half — is already PR #51, and it merges first.

