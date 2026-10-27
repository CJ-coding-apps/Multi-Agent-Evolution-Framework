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
- **`packages/cli/src/wiring.ts`** — `createRunLcm` is the one construction of the engine, the
  summarizer and the recorder (R1). It backs the summarizer with the run's `CliAdapter`, resolves
  the model (`summarizerModelFor`: `lcm.model`, else the run's model, else the adapter's own), and
  is what `maf run`, `buildRunStack` (goldens, the in-process demo, evolve) both call. Two copies
  is how `maf run`'s wiring survived seven mutants before; there is one now.
- **`packages/cli/src/commands/run.ts`** — `maf run` calls `createRunLcm` and closes it with the
  stack. It holds no LCM construction of its own (R1).
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
  will drop. `assembleContext` fits the archive, renders the newest messages that fit after it,
  and compacts — at that same assembly — every uncompacted message the budget did not render,
  re-fitting until nothing is uncovered. The tail that stays raw is what was rendered rather than
  a fixed count; `freshTailCount` only bounds the raw candidates while compaction is warranted.
  Fresh messages, summaries and ghost cues are counted against `tokenBudget`, so the budget is a
  ceiling. `Dolt` mode returns ghost cues; `Upward` mode returns the summaries themselves
  (`LcmContext.summaries`).
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
run. **D-52 is recorded here, in full; `docs/DECISIONS.md` is untouched until WP-3.13's
documentation pass moves this entry there.** The findings are the verifier's F1–F14;
`F15` belonged to WP-3.8 (#51). A second verifier pass found R1–R14, which the last subsection of
this round records; D-52 below states the corrected position, not the first round's.

#### D-52 — the decision, and the alternative each choice rejects

**A summary is a model call like any other.** Every summarization call, at level 0 and at every
raised level, is recorded through the attestor with its summary id, level, message count, content
and reported tokens, the model and prompt/output digests, and the node whose assembly triggered it
(or the session for a background pass). Its cost is recorded on every call as
`tokenBudgetCharged` — the backend's reported count when it reports one, otherwise the estimate of
the prompt plus the summary — and subtracted from the node's `tokenBudget` only where the role sets
one. **R5:** no built-in role sets a `tokenBudget`, so enforcement is real but dormant; the record
is complete regardless. **R6:** a backend that returns no model surface (Ollama, OpenRouter) still
gets one, synthesised by the summarizer from the model, the prompt digest and the output digest.
*Rejected:* recording only the summary text, because a bundle that says a node had a full budget
after MAF spent part of it overstates what the node could do; attributing the call to the session
always, because then no node owns a cost it caused; and reporting only `contentTokens` where the
backend reported nothing, which would omit the prompt the call actually paid for.

**The injector's budget covers what the injector renders, and nothing is left uncovered.** Summaries
(or cues) are fitted first; the session's newest messages are then rendered as `<recent>`, newest
first, inside the same remaining budget. **The covered invariant (V1):** at every assembly, every
message of the session is either rendered in `<recent>`, covered by a summary (directly or through an
ancestor), or newer than that assembly. The tail that stays raw is *what was rendered*, not a fixed
count: a message that does not fit is compacted at that same assembly, whatever its age, and the
assembly re-fits until nothing is uncovered. A bound on the passes is a backstop; reaching it
compacts what is left and returns the archive, because the guarantee outranks the rendering. Room is
rendered size; a summary call's cost is about the call and never shrinks the room (R2).
*Rejected:* the round-1 premise that the raw tail was the node loop's own history and needed no
rendering — it is earlier nodes' messages and reaches no prompt otherwise; the round-2 rule that a
message that did not fit was "summarized at the next compaction" — compaction never touched the
newest `freshTailCount`, so with defaults 33 messages sat in neither the prompt nor any summary and
the band grew; and subtracting `tokensUsed` from the archive's room, which emptied the archive on
backends that report usage.

**One wiring, proven through the path the user runs.** `createRunLcm` is the only construction of
the engine, summarizer, sub-agent, session id and record callback; `maf run`, `buildRunStack`
(goldens, evolve, the in-process demo) all call it. The proof drives `runTask` itself.
*Rejected:* two constructions with a test of the one the commands use, which is how `maf run`'s
seven untested mutants arose.

**Every summarization call is bounded, by bytes over the whole command line.** The prompt plus a
stated allowance for the rest of the summarization argv is held under a cap below Linux's
per-argument limit; `splitByBytes` is code-point-safe. *Rejected:* a character cap, which let
60,000 `'中'` (180,000 bytes) through to a process that could not start; and relying on the
backend to reject an oversized argv, which fails with an error naming neither the summary nor the
cap.

**Compaction failure degrades and is recorded.** Only a `TransportError` is retried (one extra
attempt by default); a verdict is not. The assembly continues uncompacted, the bundle carries an
`lcmDegraded` entry, and the transcript says so. *Rejected:* failing the node on a background
optimization, and the silent catch, which made a failure indistinguishable from compaction that
ran.

**A summarizer is given the size it must fit, and a root that still does not fit falls back to
cues (L3).** Every summarization call made during an assembly is asked for at most half the
injector's budget — a stated target, not a hope that each level happens to shrink. When the
archive's single root still exceeds the budget, it is re-summarized once at a quarter of the budget
(half the normal target); if that root is still too large, the injector renders a cue for it and the
assembly records `lcmDegraded` with `reason: root-over-budget`, the root's id and its token count,
and prints one transcript line saying so. *Rejected:* letting the model choose the size, measured
in the live row where higher levels never shrank and the `<summaries>` sentence was false; and
dropping an oversized root, which loses context silently.

**One compaction per session, including every upward pass (L4).** A per-session lock serializes
compaction, and each pass — level-0 and every `fitUpward` merge — re-reads the data after taking
the lock and skips what another pass already covered. The upward pass used to run unlocked: two
concurrent assemblies summarized the same roots, paid for them twice and wrote a summary with two
parents, so the archive was a DAG. *Rejected:* a global lock, which serializes unrelated sessions;
and no lock, which let concurrent nodes summarize the same messages twice.

**The archive's schema is versioned, and the parent relation is stored the way its columns are
named (L2).** `lcm_summary_parents` stores `(summary_id = child, parent_id = parent)`; `LcmSummary`
reads those rows as `parentIds` — a summary's true parents — and a root is a summary with none.
The version is SQLite's `user_version`, currently 2. Opening an unversioned (or version-1) archive
swaps the relation once, in a single transaction, and records the migration in `lcm_migrations`;
opening an archive newer than this build refuses with a message rather than reading it upside down.
*Rejected:* rewriting on read (a reader cannot tell the direction without a version), and silent
best-effort reads of an unknown layout.

**Credentials are masked into and out of the archive.** `addMessage` redacts before storing; the
summarizer input is redacted at the one place every prompt passes through; level-0 output is
redacted before it is stored; a raised summary's output is redacted too; and `lcm.expand` redacts
both the summary text and every source message it returns. *Rejected:* masking only at the
transcript sink, because a summary is re-injected into later prompts and re-summarized at higher
levels.

**`lcm.expand` exists, in every role's registry, scoped to its run.** A read-only, pathless tool
returns a summary and its masked source messages; a registry without an archive says so. The
engine filters every lookup by its session id, so an id from another run is refused with a message
that says so. *Rejected:* leaving the Dolt cue naming a tool that does not exist; and looking a
summary up by id alone, because `.maf/lcm.db` outlives the run that wrote it.

**Compaction is hierarchical.** Level-0 summaries rise into level+1 summaries that record the
summaries they ingested (as their children) and link every descendant message, until one root
covers the segment; `LcmSummary.parentIds` names a summary's parents, so the root is the one with
none. Nothing is dropped without an ancestor covering it. *Rejected:* keeping only level 0, where
the archive grows without bound and the budget trims the oldest context permanently.

**A node's final answer is recorded once (T1).** The in-process pipeline's transcript processor
writes each step's assistant text at `step_end`, the final step included; the dispatcher appends
the final answer only when the pipeline did not, and the cli tier (which has no pipeline) still
does. The version this replaces appended it again for an in-process turn, so the same answer sat in
the transcript and in `lcm_messages` twice and was summarized and charged twice.
*Rejected:* removing the `step_end` record, which would lose every intermediate step, and removing
the dispatcher append unconditionally, which would lose a cli-tier result and a custom bundle's
output.

**Two token counts, two questions.** A summary's stored context size is the content's own
estimate; the backend's reported count goes on the call's record. *Rejected:* using the reported
count as the context size, which charges a later prompt for tokens the text does not occupy; and
using the estimate as the call's cost, which hides what the backend billed.

**The live test proves storage, not presence.** A near-zero threshold forces compaction while a
4096-token budget leaves room, and the test asserts the summary is in `lcm_summaries` and
reachable through `expandSummary`; a tight budget could not distinguish "never stored" from
"dropped for room". The nightly schedule is WP-3.12's.

**The resolved settings reach the engine and are recorded.** Mode, threshold, tail, model,
operator and timeout are passed in, not re-defaulted in the wiring, and the settings in force —
mode, operator, thresholds, timeout, model — are recorded once in the bundle (R4a). `lcm.mode:
off` compacts nothing and stores nothing, and the recorded mode says so. *Rejected:* re-defaulting
in the wiring, which hides what a run actually used; and treating `off` as an invalid value, which
forces a user who does not want the feature to disable it by threshold and leaves the record
silent.

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
- **A call is recorded on every backend** (R6). Ollama and OpenRouter return no `modelSurface`,
  so a summary made through them was recorded nowhere. When the adapter reports none, the
  summarizer builds one from what it knows — the configured model, the digests of the prompt it
  sent and the output it received, `toolCatalog: ''` — and the record is written exactly as before.
  A test drives a stand-in adapter that returns no surface and asserts the record still exists.
- **`packages/cli/src/wiring.ts`** — `recordSummaryCall` writes `kind:'lcm-summary'`,
  `role:'lcm'`, `nativeTools:'none'`, attributed to the triggering node/task (session alone for a
  background pass).
- **`packages/roles/src/RoleDispatcher.ts`** — writes one `[surface] lcm summary …` transcript
  line per call, and subtracts the call's `tokenBudgetCharged` from the node's `tokenBudget` where
  the role sets one. Every call records its charge; enforcement exists only where a budget does
  (R5, below).

### F2 — the injector's budget covers what the injector renders

- **`packages/prompt-injector/src/GraphAwareInjector.ts`** — the archive is assembled first and
  gets its budget before the graph. Summaries/cues fit first; the session's **newest messages are
  then rendered after them as `<recent>`, newest first, inside the same budget** (R4c). The
  round-1 text said the fresh tail "is not rendered and is not charged" on the premise that those
  messages were the node loop's own history and already in the prompt; that premise was false.
  They are earlier nodes' messages, the adapter sees only the prompt the injector builds, and on a
  session whose loop had not carried them they reached no prompt at all. **V1:** a message that does
  not fit in the remainder is neither rendered nor left in the store unsummarized — it is compacted
  at that same assembly, and the assembly re-fits until every message is rendered, covered by a
  summary, or newer. The round-2 sentence ("summarized at the next compaction") was false for every
  message inside the newest `freshTailCount`: compaction never touched that tail, so the message
  waited for 64 newer ones and, with defaults, a band of 33 sat in neither the prompt nor a summary.
- **Room is rendered size; cost is the call** (R2). `assembleContext` returns what it rendered and
  the budget it charged, and the injector subtracts nothing on account of what a summarization call
  *cost*. On a backend that reports `tokensUsed`, the round-1 code subtracted that cost from the
  archive's room, so a 9,000-token summary call removed the `<summaries>` block it had just paid
  to make. `tokensUsed` goes only to the budget record (`tokenBudgetCharged`), never to rendering.
- **`packages/lcm/src/LcmEngine.ts`** — a message is kept raw or summarized then dropped, never
  dropped unsummarized, and the decision is made in the same assembly rather than a later one (V1).
  A failed compaction (F5) returns every uncompacted message and records the failure.

### F3 — one LCM wiring, proven through the path the user runs

- **`packages/cli/src/wiring.ts` — one factory** (R1). `createRunLcm` builds the engine, the
  summarizer, the sub-agent, the session id and the record callback; `buildRunStack` (goldens,
  the in-process demo, evolve) and `runTask` (`maf run`) both call it. Before this, `run.ts` kept
  its own copy of the construction, which is how seven mutants survived the first round's tests.
- **`packages/cli/src/__tests__/run-lcm-run-task.test.ts`** (new) — drives **`runTask` itself**
  with a scripted adapter past the threshold, and asserts the summarization invoke (the run's
  model when `lcm.model` is absent, `nativeTools:false`, the configured timeout, the run's working
  directory), the summary in the next node's prompt, the bundle record, the charged budget, the
  settings in force, and that another run's session id cannot expand the summary. Its oracle lists
  the seven inputs `run.ts` gives the factory (K1–K7); dropping or altering any one of them fails
  it.
- **`packages/cli/src/__tests__/run-lcm-wiring.test.ts`** — the stack-level proof, with this
  file's own labels W1–W4 (deliberately not the verifier's mutant ids, per R1). It covers the
  stack the other commands share, both operators, `lcm.mode: off`, and both failure classes.
- **`lcm.operator: llm-map | agentic-map`** — config field, validator and `buildRunStack` wiring.
  `agentic-map` reaches `AgenticMap`; a missing `runSubAgent` is an error, never a silent
  downgrade.
- **`packages/lcm/src/SessionMerger.ts`** — a merge re-links each shared summary to the copied
  messages' new ids, so the target session sees the archive its messages point at.

### F4 — every summarization call is bounded, by bytes over the whole command line

- **`packages/lcm/src/summarizer.ts`, `LcmEngine.ts`** — the cap is **bytes**, not UTF-16 code
  units (R3): `Buffer.byteLength` of the prompt plus a stated allowance for the rest of the
  summarization argv (`SUMMARY_ARGV_ALLOWANCE_BYTES = 8 KiB`) is held under
  `MAX_SUMMARY_ARGV_BYTES = 128 KiB`, with `MAX_SUMMARY_PROMPT_BYTES = 64 KiB` for the prompt
  itself. Linux limits one argv argument to 128 KiB and the verifier measured `E2BIG` at about
  150,000 bytes, so a character cap let a 60,000-character string of `'中'` (180,000 bytes) through
  to a process that could not start. `splitByBytes` is code-point-safe, so no split cuts a
  character in half. The prompt could not be moved to stdin (the adapter path this call uses takes
  it as an argument), so the byte cap is the boundary.
- **The test** sends 4 × 60,000 `'中'` and asserts every call is under the cap and none is
  degraded; a second test refuses an oversized prompt **before** the backend is started.

### F5 — a failed compaction degrades, and says so

- **`packages/lcm/src/LcmEngine.ts`** — only a `TransportError` is retried (`summaryRetry`,
  default one extra attempt); a verdict is not. After the retries the assembly continues
  uncompacted.
- **`packages/types/src/index.ts`, `packages/attestation/src/Attestor.ts`** — `LcmDegradedRecord`;
  `Attestor.recordLcmDegraded`; `bundle().lcmDegraded` only when non-empty.
- **`packages/roles/src/RoleDispatcher.ts`** — `[lcm] compaction failed: <reason>; continuing
  uncompacted` on the transcript.
- **`lcm.summaryTimeoutMs`** — the timeout was a constant in two places (`120_000`); it is a
  config key. It is pinned at the config loader, at the adapter call and **through `runTask`**
  (R8): the runTask test sets 4,321 and reads it off the summarization invoke.

### F6 — one compaction per session, no double coverage

- **`packages/lcm/src/LcmEngine.ts`** — a per-session lock serializes compaction, and
  `compactLocked` re-reads under the lock and skips ids whose `summary_id` is already set. Shared
  by `CompressionAgent` and `assembleContext`; at `maxConcurrent: 4` the test sees one call and
  each message in exactly one summary.

### F7 — credentials are masked into and out of LCM

- **`packages/lcm/src/LcmEngine.ts`** — four separate layers, each pinned by its own test (R8):
  `addMessage` redacts before storing; the summarizer input is redacted at the one place every
  prompt passes through; a level-0 summary's output is redacted before it is stored; and a raised
  summary's output is redacted too (R10 — the round-1 `raise()` stored level ≥ 1 text without the
  mask). A test drives a fake key through `addMessage` → summary → injected prompt and finds it
  nowhere.
- **`packages/tools/src/plugins/lcm.ts`** — `lcm.expand` redacts **both** halves it returns: the
  summary text and each source message. The round-1 test only put a credential in the sources, so
  a dropped mask on the summary half was invisible; the fixture now carries one in both, and the
  summary is asserted masked on its own.

### F8 — `lcm.expand` makes the Dolt cue true, within its own run

- **`packages/tools/src/plugins/lcm.ts`** (new), `packages/tools/src/index.ts`,
  `packages/roles/src/defaults.ts`, `.maf/roles.yaml` (and the packaged copy) — a read-only,
  pathless tool returning the summary text and its masked source messages, in every role's
  registry. The Dolt cue names it, so it has to exist. A registry without an archive refuses with
  that reason rather than claiming the id is unknown. `REVIEWER_PROMPT`'s "Tools available" line
  omitted it while the catalogue carried it (R13); a test now compares each prompt's list with
  its role's `allowedTools`, so the two cannot drift.
- **Run scoping** (R9). `.maf/lcm.db` persists across runs, so a summary id from run A was
  expandable from run B's session. The engine now takes a `sessionId` and every read is filtered by
  it (`LcmStore.getSummaryInSession`, reached through `expandSummary`); an id outside the session
  is refused, and the error
  says the id belongs to another run rather than that no such summary exists. The runTask test
  reopens the same database under a second session and gets `undefined`.

### F9 — hierarchical compaction

- **`packages/lcm/src/LcmEngine.ts`** — after level 0, `raise` summarizes children into level+1
  summaries that record those children and link every descendant message, until one root covers
  the segment. Nothing is dropped without an ancestor covering it; `lcm.expand` on the root
  recovers the whole segment. L2: a summary's `parentIds` names its parents (the summaries above
  it), so the root is the summary with none.

### F10 and F11 — token semantics and the live test

- **`packages/lcm/src/LcmEngine.ts`** — a summary's stored context size is the content's own
  estimate; what the backend reported goes on the call's record. They answer different questions.
- **`packages/cli/src/__tests__/lcm-live.test.ts`** — a near-zero `contextThreshold` forces
  compaction while a 4096-token budget leaves room, and the test asserts the summary is in
  `lcm_summaries` and reachable through `expandSummary`, not merely present in a tight context.

### F12–F14 — settings, `off`, and this record

- **`packages/cli/src/wiring.ts`** — `buildRunStack` and `runTask` take the resolved `lcm` settings
  (mode, threshold, tail, model, operator, timeout) through one factory instead of hard-coding
  them.
- **The settings in force are recorded once per run** (R4a). `Attestor.recordLcmSettings` writes
  `{mode, operator, contextThreshold, freshTailCount, summaryTimeoutMs, model}` into the bundle's
  predicate, so a bundle says which LCM a run used rather than leaving it to be inferred from
  behaviour. The runTask test reads the record back and compares every field.
- **`packages/types/src/index.ts`, `ConfigLoader.ts`** — `LcmMode` gains `off`; no compaction,
  no summaries, no cues, and the mode is recorded rather than unexplained.
- This document + D-52; the D-26 citations that named the merge-policy rule for LCM defects are
  replaced with D-17 (mechanism) and D-52 (choices).

### Round 2 — R1–R14, against D-52

The second verifier pass accepted the design and found four narrow HIGHs and the rest below.
D-52 above carries the corrected position; this list is the disposition.

| | Finding | Disposition |
|---|---|---|
| R1 | `maf run` kept its own LCM construction; seven mutants survived | One factory, `createRunLcm`; proof through `runTask` itself (K1–K7); the other file's labels renamed W1–W4 |
| R2 | On a backend that reports usage, the call's cost was subtracted from the prompt's room | Room is rendered size; the charge goes only to the budget record. Test: `tokensUsed: 9000` still renders `<summaries>` |
| R3 | The size cap counted characters; Linux limits bytes | Byte caps over the whole argv, with a stated allowance; 4 × 60,000 `'中'` under the cap, nothing degraded |
| R4 | Four false statements | Settings recorded in the bundle; counts re-measured; the fresh-tail premise corrected (`<recent>` is rendered newest-first after the summaries, within budget); the base-branch flake finding removed (it is #51's) |
| R5 | Cost recorded but rarely enforced | Recorded on every call as `tokenBudgetCharged`; enforced only where a role sets `tokenBudget`; D-52 says no built-in role does |
| R6 | Summaries through Ollama/OpenRouter went unrecorded | The summarizer synthesises a surface when the backend returns none |
| R7 | Undeclared files; D-52 in the wrong home | This section, the file list below, the WP-3.15 note, and D-52 moved here |
| R8 | Masking/test layers unpinned | Per-layer tests for `addMessage`, summarizer input, summarizer output, raised summaries and `lcm.expand`'s summary text; the transcript line and the timeout are pinned too |
| R9 | `lcm.expand` could read another run's summaries | Session-scoped lookups; an id outside the session is refused, and the test proves it with two runs in one `.maf/` |
| R10 | `raise()` stored level ≥ 1 output unmasked | Masked before storing |
| R11 | `packUnits` never split a child, though two comments said it did | `splitByBytes` splits a child at the byte cap in both `raise` and `fitUpward`; the comments are true |
| R12 | One oversized root rendered nothing and said nothing | Falls back to cues from the same roots |
| R13 | `REVIEWER_PROMPT` omitted `lcm.expand` | Added; a test now compares every "Tools available" line with its role's `allowedTools` |
| R14 | A cli-tier role cannot call `lcm.expand`, but a Dolt cue told it to | The injector renders summaries instead of cues when the role has no MAF tool registry (`render: 'summaries'`) |

### Round 3 — V1–V5, against D-52

The third pass found that round 2's own ruling was wrong, and that three mutants still survived.

| | Finding | Disposition |
|---|---|---|
| V1 | "Summarized at the next compaction" was false for every message inside the newest `freshTailCount`; with defaults a band of 33 messages reached neither the prompt nor a summary, and the band grew | The tail that stays raw is **what the assembly rendered**, not a fixed count. A candidate that does not fit is compacted in that same assembly and the assembly re-fits; `MAX_ASSEMBLY_PASSES` is a backstop, and reaching it compacts what is left and returns the archive. The invariant — at every assembly each message is rendered, covered by a summary or an ancestor, or newer — is stated in D-52, `LcmEngine`, `GraphAwareInjector`, `LcmContext.messages` and here. The test runs ten assemblies at the defaults and at a small budget and checks every session message against it. |
| V2 | Dropping `sessionId` from `createRunLcm` (CS3) survived the whole suite | A `runTask` test runs twice in one `.maf/`; run B's own in-process role calls the run's `lcm.expand` with run A's id and is refused. The mutant is killed. |
| V3 | A D-52 pointer stub remained in `docs/DECISIONS.md`, which this WP must not touch | Removed; `git diff origin/wp/phase-3b...HEAD -- docs/DECISIONS.md` is empty. |
| R8 | N12b (output masking) and N12d (input masking) survived | One test per layer, each with the other layer's input clean, so removing either alone turns its test red. |
| R14 | Forcing `mafToolsAvailable: true` for a cli-tier role survived | A dispatcher-level test pins the flag `false` for a cli-tier role and `true` for an in-process one. |
| V5 | The headroom arithmetic said "~22 KiB" | 150,000 − 131,072 = 18.5 KiB, and the 64 KiB prompt cap is the limit that matters because the prompt is one argument. |
| — | V2's real-wiring test found a live defect: a reader that wrote nothing failed with `unexpected_change` on `.maf/memory.kuzu.wal` | A Kùzu database is the file **and** its sibling write-ahead log (D2), so `memory.kuzu.wal` joins `MAF_RUNTIME_STATE` and the root `.gitignore`. MAF's own graph appends to it while open; keeping it in a snapshot reports MAF's state as the node's change. |

## Files outside the spec's list, and why

Every file this branch changes that the WP-3.2 spec did not list, with the reason and the line
range (R7). "Line range" means the hunks this branch writes, not the whole file.

| File | Reason | Where |
|---|---|---|
| `packages/roles/src/RoleDispatcher.ts` | The archive is assembled before the node's prompt and its summary calls become records: the summary transcript line, the spend against the triggering node's budget, and the one flag that tells the injector whether the role can call `lcm.expand` (R14). Not this WP's file — it is line-scoped for WP-3.4/3.5 — so the edits sit in one region. | `mafToolsAvailable` :732; the `lcmSummaryCalls` transcript loop :738–754; the summary spend :776–784 |
| `packages/attestation/src/Attestor.ts` | The run's LCM settings are recorded once and emitted in the bundle (R4a), so `lcm.mode: off` is readable in the record rather than inferred. | field :260; `recordLcmSettings` :385–387; `lcmSettings` in the predicate :428 |
| `packages/tools/src/index.ts` | `LcmExpandTool` is exported and registered in `createDefaultRegistry`, which is what makes the Dolt cue's `lcm.expand("<id>")` callable by every built-in role (F8). | export :7–8; import :11; option :31; construction :45 |
| `packages/tools/src/plugins/lcm.ts` | New: the read-only, pathless `lcm.expand` tool. Masks the summary text and every source message (F7, R8), and refuses an id that is not in this run's session (R9). | whole file |
| `packages/roles/src/defaults.ts` | Every built-in role gains `lcm.expand` in `allowedTools`, and the three read-only prompts' "Tools available" lines gain it too — a cue the role cannot follow is a dead reference. | prompts :58, :67, :98; tool lists :71, :78, :82, :86, :101 |
| `.maf/roles.yaml` and `packages/cli/assets/roles.yaml` | The same one id per role in both copies of the shipped role file: the run loads the first, `maf init` writes the second. | :11, :25, :35, :46, :57 in each |
| `packages/cli/src/wiring.ts` | `summarizerModelFor` :79 and `createRunLcm` :113 — the single LCM construction (R1), called by `buildRunStack` :244 and by `run` :267. The summary model, the timeout, the operator and the settings record all come from here, once. | :73–160, :244 |
| `packages/cli/src/commands/run.ts` | `maf run` no longer builds its own LCM; it calls `createRunLcm` and closes the result with the stack. This was the file whose seven mutants survived round 1. | import :27; call :267; close path beside the stack |
| `packages/cli/src/commands/{goldens,evolve,inprocessDemo}.ts` | Each passes `lcm: DEFAULT_MAF_CONFIG.lcm` to `buildRunStack` and states that it reads no config file (F12): the stack requires the setting rather than defaulting it, so a command cannot silently run another mode than the one it printed. | goldens :185; evolve :69; inprocessDemo :186 |
| `packages/cli/src/config/ConfigLoader.ts` | `lcm.model`, `lcm.operator` and `lcm.summaryTimeoutMs` are read, validated by name and in `LCM_FIELDS`; `lcm.mode` accepts `off`. A key that is accepted but unread is how the section became inert before. | the `lcm` section and `LCM_FIELDS` |
| `packages/cli/src/main.ts` | `merge-runs`' summarizer throws instead of fabricating text. `merge-runs` never assembles a context, so it never summarizes; the placeholder was dead code that could have become a false summary if that changed. | the `merge-runs` summarizer |
| Tests in `roles`, `tools` and `cli` | The proofs the round-2 rulings ask for, each in the package it exercises: `run-lcm-run-task.test.ts` (K1–K7, through `runTask`), `run-lcm-wiring.test.ts` (W1–W4), `lcm-config.test.ts`, `RoleDispatcher.test.ts` (the summary transcript line, R8), `defaults.test.ts` (the prompt/catalogue and budget pins, R13), `lcm-expand.test.ts` (masking, R8), `lcm-live.test.ts`, and `lcm/src/__tests__/*` for the engine and the summarizer. | — |
| `packages/cli/src/__tests__/approval-gate-stack.test.ts` | The test now creates `mafDir` explicitly. `buildRunStack`'s contract is that the caller creates it (`run` and `goldens` call `ensureMafDir`); the test passed only because Kùzu **0.7.1** creates a missing parent directory as a side effect of a schema query. Measured: `new Database(<missing parent>)` then a query creates it on 0.7.1 and fails on 0.11.3. Creating it makes the test prove the stack, not a library's side effect. This file is not WP-3.2's, and WP-3.8 (0.11.3) needs the same change; it is declared here because the WP-3.2 lane measured the behaviour. | setup |
| `packages/git-ops/src/SnapshotDiff.ts` and `.gitignore` | `memory.kuzu.wal` joins `MAF_RUNTIME_STATE` and the mirrored block in the root `.gitignore`. V2's real-wiring test exposed the consequence of D2 here: maf's `MemoryGraph` keeps a write-ahead log beside the database while it is open, and a snapshot that kept it reported MAF's own state as the reader's change, failing the node with `unexpected_change`. `ensureMafDir` derives `.maf/.gitignore` from this list, so new repositories get the entry too. | `MAF_RUNTIME_STATE`; `.gitignore`'s "MAF runtime state" block |
| `packages/cli/src/__tests__/wiring-stack-cleanup.test.ts` | The M1 test's removability check does **not** retry `ENOTEMPTY`: the earlier retry (`maxRetries`, `retryDelay`) was dropped in `6beab28` once the close became deterministic. `buildRunStack`'s `close()` now awaits `graph.close()`, which resolves only after the native release (WP-3.8 close-await, `#56`, merged here from `wp/phase-3b`), so the directory is removable the moment the awaited close returns — there is no transient window left to retry. A graph that was *not* closed keeps the directory and the single `rm` fails, so the assertion remains the one the mutant turns red. Not this WP's file; declared because this round measured the flake. | the two `rm` calls |

### Note for WP-3.15

`packages/roles/src/defaults.ts`, `.maf/roles.yaml` and `packages/cli/assets/roles.yaml` are
WP-3.15's files — the reconciliation of the built-in role set with the shipped role file. This
branch adds `lcm.expand` to every role in all three, and `defaults.test.ts` now asserts that the
shipped file grants it too. WP-3.15's reconciliation must keep the id in every role it carries
over, and keep that test: a role without it is handed a Dolt cue it cannot follow.

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

The base branch's red CI on `origin/wp/phase-3b` @ `35e1f32` was reported here in round 1 and is
not this fragment's finding any more: it belongs to WP-3.8 (#51), where it was fixed.

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
| `pnpm -r test` | exit 0 — **1206 tests, 1204 pass, 0 fail, 2 skipped** |

The two skips are `lcm-live` (needs `MAF_LIVE_SUMMARIZATION=1` and a real adapter; it is not run
as part of the suite) and one pre-existing skip in `@maf/tools`.

New/expanded tests: `lcm/src/__tests__/adapter-summarizer.test.ts`,
`lcm/src/__tests__/lcm-engine.test.ts`,
`prompt-injector/src/__tests__/injector.test.ts`,
`transcript/src/__tests__/transcript-logger.test.ts`, `cli/src/__tests__/lcm-config.test.ts`,
`cli/src/__tests__/run-lcm-run-task.test.ts` (R1: through `runTask` itself, K1–K7),
`cli/src/__tests__/run-lcm-wiring.test.ts` (F1–F5, F12, F14 through the real stack, W1–W4),
`roles/src/__tests__/RoleDispatcher.test.ts` (R8: the summary transcript line and its surface),
`roles/src/__tests__/defaults.test.ts` (R13: each prompt's tool list equals the role's tools),
`tools/src/__tests__/lcm-expand.test.ts` (F7, F8, R8: both halves masked), and the env-gated
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

