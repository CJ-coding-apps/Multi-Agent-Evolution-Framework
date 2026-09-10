# NOTES — HarnessX Integration (maf-v1)

Multi-session working notes per AGENTS.md §7. Updated at end of each build session.

## Status

## Session 2026-09-09 (session 1) — Phase 0 + Phase 1 built

**Done:**
- Phase 0: `packages/harness-config` — HarnessConfig (structural HarnessRoleSet, ProcessorRef name-refs, PlannerRecallConfig), canonical JSON + sha256 mint, HarnessStore under `.maf/harnesses/` (`<sha>.yaml` JSON-in-yaml repo convention, `index.json` id→sha, `CURRENT` pointer), `assertHarnessConfig` boundary parse. Wired: `mafx run --harness <ref>` (+ legacy auto-mint `legacy-default`), attestation bundle stamps harness as `invocation.configSource` (uri + sha256 digest) and `parameters.harnessId`, `Attestor` 5th param stamps `harness_sha` on ToolInvocation graph nodes, Run node carries `harnessId`/`harness_sha`, `maf harness list|show|set-current` CLI.
- Phase 1: `@maf/processors` — 8 hooks, event union, HOOK_CONTRACTS table, Processor base (singletonGroup/order/softAfter), ProcessorPipeline with per-processor contract validation (ContractViolation), StaticProcessorRegistry (no dynamic loading — §10.2), default bundle: policy-audit / secret-redact / transcript / security-gate. `TurnAdapter`+`TurnMessage`+`isTurnAdapter` in @maf/types; `AdapterCapabilities.inProcessLoop`. `InProcessAgentLoop` in tool-loop + shared `executeToolGated` (ToolLoop refactored to use it). ClaudeAdapter.sendTurn (fenced `tool_call` JSON protocol — MAF-defined wire format; real Claude Code CLI doesn't expose per-call interception, so the loop drives tools itself). RoleConfig.execution 'cli'|'in-process' (default cli ⇒ legacy path byte-identical). RoleDispatcher gate: in-process only when role asks AND adapter has capability; warning + fallback otherwise; security gate runs exactly once (task_end processor in-process, post-hoc on CLI/fallback path).

**Verified:** full monorepo build clean; 135 tests pass, 0 fail (7 harness-config, 12 processors, 6 RoleDispatcher dispatch tests incl. policy-deny/allowlist/fallback/budget-cap, all pre-existing suites green).

**Decisions:**
- Harness stamping goes in `invocation.configSource` (existing SLSA slot) — no AttestationBundle type change, legacy verify() unchanged.
- DAG fix: harness-config carries RoleSet *structurally* (HarnessRoleSet, string tool ids); cycle broken harness-config↔roles via `roleSetFromHarness()` boundary parse in roles (packages/roles/src/harnessBridge.ts).
- Equivalence goldens re-scoped: legacy CLI path is one opaque invoke (no tool calls visible), so "same tool sequence" equivalence isn't testable until a second TurnAdapter exists. Instead: gating-parity tests on the in-process path (policy/allowlist/fallback/budget) + pipeline contract tests. Flag if a real second adapter lands.
- Coder security gate: in-process runs SecurityGateProcessor at task_end (throws → runNode throws, same as before).

**Not verified (needs real CLI + network):** ClaudeAdapter.sendTurn against a live `claude` binary; end-to-end `run` with an in-process role. Milestone-type item per repo convention.

**Next:** Phase 2 (@maf/eval-harness: GoldenTask+provenance, verifiers, GoldenRunner with worktree isolation+pass@2, ScoreRecorder, `mafx goldens run|compare`). Then Phase 3 (@maf/evolver).

## Session 2026-09-10 (session 2) — Phase 2 + Phase 3 built

**Done:**
- Phase 2: `packages/eval-harness` — GoldenTask schema with REQUIRED provenance (spec|production-trace|human-decision, §10.4), VerifierRef sum (test-script/security-gate/diff-match/llm-judge), GoldenRunner (per-attempt temp-dir copy isolation, pass@k, temperature pinned 0 via new `AdapterInvokeOptions.temperature`), pure `seesawDecision` (decide-don't-perform), ScoreRecorder (GoldenResult node + SCORED_BY edge — new kinds added to @maf/types). `GoldensSection` added to AttestationBundle + `Attestor.bundle(..., goldens?)`. Seed corpus `tests/goldens/` (10 tasks: 6 coder test-script, 3 security llm-judge w/ rubrics, 1 reviewer llm-judge) — validates against schema. CLI: `maf goldens run|compare` (compare = seesaw, exit 1 on regression — smoke-tested both paths).
- Phase 3: `packages/evolver` — bounded HarnessEdit union with parse-time field exclusion (ALLOWED_FIELDS), `applyEdit` pure mint, `screenInstructionText` (injection patterns + bounds + non-ASCII density), deterministic `digestEvidence` (graph-only, no LLM), planner (fenced-JSON manifest parse, no_op), critic (one revision max, fail-closed on unparseable), `gateEvaluate` stages b → b2 screening → b3 sensitive-role approval → d seesaw → e improvement + llm-judge-only rule, `evolve()` loop (patience/budget, EvolutionRound nodes, approval-before-evaluation for sensitive roles). `EvolutionRound` kind added to types. Shared `cli/src/wiring.ts` buildRunStack (single home for component construction; goldens.ts refactored onto it). CLI: `maf evolve`.
- 157 tests, 0 failures. Full monorepo build clean.

**Decisions:**
- Sensitive-role manifests archive without evaluation spend when `--approve-sensitive` absent (approval BEFORE evaluation §6.3).
- Baseline golden scores reconstructed from graph history when available; else one baseline run.
- judgeOnlyTaskIds computed from corpus (all-verifiers-llm-judge) — groundable improvements only.
- Phase 3.5 variant isolation NOT built (plan-gated: only after 3+ conflicting no-ship rounds observed in practice).

**Not verified (milestone, needs real CLI+network):** live `maf evolve` run against corpus; ClaudeAdapter.sendTurn against live binary; securityScore/llm-judge adapters in goldens run.

**Dead ends:** TS6305 composite-cache trap (fix: rm dist + tsconfig.tsbuildinfo); DAG cycle harnessConfig↔roles broke via structural HarnessRoleSet + roleSetFromHarness bridge; tsc emits despite errors (noEmitOnError unset) — check `error TS` lines, not just test output.

## Session 2026-09-10 (session 3) — audit fix pass (H1,H2,M1–M4,L1–L6)

**Done (post-audit correctness + completeness fixes; 175 tests, 0 fail; build+typecheck clean):**
- **H1** (model was blind to tools): shared `@maf/adapter-base/turnProtocol.ts` (TOOL_PROTOCOL/serializeHistory/parseTurn + new `serializeTools`/`buildTurnSystemPrompt`). `serializeTools` advertises the tool **id** (the loop resolves calls by id, not name). Claude + Codex sendTurn now inject the allowlisted tool catalog.
- **H2/M2**: `SecurityGateProcessor` runs the coder gate on ANY outcome (was `completed`-only) — budget_exhausted/failed runs with a diff are now reviewed; matches the always-review CLI path (runPostCoderGates no-ops on empty diff).
- **M1**: `estimateTokens` in @maf/types; `InProcessAgentLoop` accumulates `tokensUsed ?? estimate(prompt+completion)` so `tokenBudget` is a real stop for CLI adapters that never report usage.
- **M3**: temperature threaded CLI→adapter — `RoleDispatcher.config.temperature` → `invokeOpts.temperature`, via `wiring.dispatchTask(..., temperature)`; OpenRouter (`temperature` in body) + Ollama (`options.temperature`) now honor it. CLI adapters (claude/codex) cannot pin temperature → help text softened, documented in buildArgs.
- **M4**: `wiring.judge` (llm-judge provider via adapter.invoke + `parseJudgeVerdict`) wired into BOTH `goldens run` and `evolve`; `securityScore` also wired into `evolve` for parity. Corpus's 3 security + 1 reviewer llm-judge tasks are now scorable (were always-failing "no llmJudge wired"). Security/reviewer tasks kept as llm-judge (they review-and-report, produce no diff, so security-gate would be the wrong verifier).
- **L1**: `@maf/processors/redaction.ts` (single source of patterns; labels unchanged). `gatedExec` redacts result stdout/stderr/metadata AND the recorded input BEFORE `attestor.record` + before returning → no secrets in the signed bundle, graph, transcript, or history (also covers the ToolLoop path which has no pipeline). PolicyAudit redacts logged input. **Decision (user): redact everywhere incl. the signed attestation** (fidelity traded for never-persist-secrets).
- **L2**: contract checker now uses union(before,after) keys → catches deleted immutable fields; `before_model` tightened to the documented contract (prior history immutable; only last *user* message text editable; ≤1 user append; truncation/reorder rejected — belongs to step_start).
- **L3**: `InProcessAgentLoop.firstEvent` throws `ContractViolation` if a hook emits >1 event (split is unsupported in the serving loop) instead of silently dropping branches. Pipeline split capability retained.
- **L4**: evolve `recordRound` wrapped — a graph failure is swallowed into the round note, never aborts the loop.
- **L5**: evolve loop reordered — critic(+1 revision) runs BEFORE the single `applyEdit`+smoke, so a revised manifest is the one smoke-tested. Approval routing stays first; candidate id scheme unchanged (existing tests green).
- **L6**: `CodexAdapter.sendTurn` implemented (shared protocol, stdin system block, no `--full-auto`), **capability kept `inProcessLoop:false`** until verified against a live binary. RoleDispatcher gate now requires BOTH `isTurnAdapter` AND `capabilities().inProcessLoop` (so a sendTurn-bearing adapter with the flag off stays on CLI). `resolveCorpusRoot` falls back to `tests/goldens` when `--corpus` has no corpus.json. Dead `const role`/`void role` removed from edits.ts; dead SECURITY prompt const removed from goldens.ts.

**Decisions:**
- Git: no version control changes (user), edited in place.
- Golden runner keeps per-attempt temp-dir copy isolation (NOT WorktreeManager) — deliberate: cleaner than worktrees for parallel fixture mutation; WorktreeManager stays in use by `run --worktree`/ReviewGate.

## Session 2026-09-10 (session 3b) — attestation fidelity refinement + end-to-end in-process run

**Attestation redaction reworked (user: "byte-faithful with only API/LLM keys and similar secrets redacted"):**
- `redaction.ts` now has two tiers. `CREDENTIAL_PATTERNS` = unambiguous API/LLM/cloud key & token & PEM-private-key FORMATS (added anthropic `sk-ant-`, google `AIza`, openai `sk-proj-`, PEM blocks). `ASSIGNMENT_PATTERNS` = the broad `api_key=…`/`password:` heuristic.
- `redactCredentials`/`redactSecrets` (credential formats only) is what `gatedExec` applies to the attestation bundle + memory graph + returned result → the signed record is **byte-faithful except genuine secret substrings** (e.g. `api_key=[REDACTED:aws-access-key]` keeps the `api_key=` and all surrounding bytes). `redactText` (credentials + assignment heuristics) is used ONLY by the model-facing `SecretRedactProcessor` (history/transcript), where fidelity doesn't matter.
- Proven: tool-loop unit test asserts the recorded stdout == raw with only the key replaced; `inprocess-demo` reads the on-disk `.bundle.json` and confirms `db_host`/`port` kept, `api_key=` prefix kept, raw key absent, signature present.

**In-process role wired + run end-to-end:**
- New `maf inprocess-demo` command (`packages/cli/src/commands/inprocessDemo.ts`): stands up a throwaway git fixture (buggy `sum.js` + failing test + a config file containing a fake AWS key), mints a harness with a **coder role `execution: 'in-process'`**, and drives it through the REAL stack via `buildRunStack` → `RoleDispatcher.runNode` → `InProcessAgentLoop` (default processor bundle: policy-audit/secret-redact/transcript/security-gate). Deterministic `ScriptedCoderAdapter` by default (reproducible offline); `--live` uses the real `claude` adapter.
- Observed (scripted): H1 the model receives the tool catalog by id (`- fs.write [write]: …`); policy **blocks `fs.delete` in-loop**; `fs.read` result the model sees is redacted with surrounding lines intact; coder **fixes `sum.js`** (real file write); **`npm test` PASS**; signed attestation bundle written; final assistant text returned. Exit 0.
- `claude` (v2.1.177) + `codex` confirmed installed; `--live` path available but a live model run is still the user's to exercise (protocol-compliance/flake risk is why the default is scripted).

**Totals:** 176 tests, 0 fail; full build + typecheck clean.

## Session 2026-09-10 (session 3c) — live run verified + bounded tool-call repair loop + docs

**Live end-to-end verified:** `maf inprocess-demo --live` drove the real `claude` (v2.1.177) through the in-process loop: it read `sum.js`, ran the failing test, `fs.write` the fix, re-ran tests → **PASS**. Signed bundle recorded fs.read/fs.write/test.run invocations; transcript shows genuine multi-turn agentic tool use. The H1 catalog + fenced protocol work against a real model.

**Bounded tool-call repair loop added** (malformed `tool_call` was previously swallowed → turn ended silently):
- `AssistantTurn.parseErrors?: string[]` (@maf/types). `parseTurn` (@maf/adapter-base) now reports blocks that are invalid JSON or missing a string `toolName` instead of dropping them; a valid block alongside a malformed one yields one call + one error.
- `InProcessAgentLoop`: when a turn has `parseErrors` AND zero valid toolCalls, append the exact parser error + required format to the conversation and retry the model call, up to `maxToolCallRepairs` (default 3, new option). After the cap → `outcome: 'failed'` with a clear error (no infinite loop). `runModelTurn` helper factors the call+after_model; repair retries count toward the token budget. If ≥1 valid call parsed, we proceed with those (don't repair).
- Tests: parseTurn error cases (adapter-base 9); repair-then-succeed + exceed-cap/bounded (tool-loop 5). **181 total, 0 fail; build + typecheck clean.**
- Re-ran both demos after the change: scripted happy path unaffected; `--live` still PASS (repair loop is a non-intrusive safety net — Claude's blocks were well-formed so it didn't fire).

**Docs updated:** `README.md` (feature bullets incl. two execution modes / processors / redaction / harness; quickstart test count 181 + `inprocess-demo`; packages table incl. processors/harness-config/eval-harness/evolver; new "In-process execution & the tool-call protocol" section incl. the bounded repair loop; run-output harness/redaction). `docs/ROLES.md` (added the `execution` field). This NOTES file.

**Still not verified (milestone):** live `maf evolve` / `maf goldens run` against a real model over the full corpus; `maf inprocess-demo --live` protocol compliance is per-run best-effort (scripted default keeps CI deterministic).
