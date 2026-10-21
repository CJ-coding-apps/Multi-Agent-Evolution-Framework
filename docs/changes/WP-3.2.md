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

### Compaction summarizes exactly what it drops (D-26)

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

## Off-spec file, declared

- **`packages/cli/src/__tests__/approval-gate-stack.test.ts`** — the test now creates
  `mafDir` explicitly. `buildRunStack`'s contract is that the caller creates it (`run` and
  `goldens` call `ensureMafDir`); the test passed only because Kùzu **0.7.1** creates a missing
  parent directory as a side effect of a schema query. Measured: `new Database(<missing parent>)`
  then a query creates it on 0.7.1 and fails on 0.11.3. Creating it makes the test prove the
  stack, not a library's side effect. This file is not WP-3.2's, and WP-3.8 (0.11.3) needs the
  same change; it is declared here because the WP-3.2 lane measured the behaviour.

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
| `pnpm -r test` | exit 0 — **1163 tests, 1161 pass, 0 fail, 2 skipped** |

The two skips are `lcm-live` (needs `MAF_LIVE_SUMMARIZATION=1` and a real adapter; it is not run
as part of the suite) and one pre-existing skip in `@maf/tools`.

New/expanded tests: `lcm/src/__tests__/adapter-summarizer.test.ts`,
`lcm/src/__tests__/lcm-engine.test.ts`, `prompt-injector/src/__tests__/injector.test.ts`,
`transcript/src/__tests__/transcript-logger.test.ts`, `cli/src/__tests__/lcm-config.test.ts`,
and the env-gated `cli/src/__tests__/lcm-live.test.ts`.

## Live rows

Not written by this lane. The spec assigns LCM's live rows to a fresh verifier, written before
this code.
