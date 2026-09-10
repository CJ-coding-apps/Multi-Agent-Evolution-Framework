# MAF — Multi-Agent Framework

CLI-agnostic orchestration for code-modifying agents. MAF plans a DAG of agent tasks, dispatches each node to a named role (coder, tester, security, reviewer) with its own tool allowlist and policy bindings, and emits a signed SLSA-style attestation bundle for every run.

The framework wraps any of several backend LLM CLIs — Claude Code, Gemini, Codex, Ollama, or OpenRouter — behind a single adapter interface, then layers:

- **Per-role dispatch** — each DAG node runs as a specific role with its own system prompt, allowed tools, and policy rules. See [docs/ROLES.md](docs/ROLES.md).
- **Two execution modes per role** — `cli` (opaque single invocation, the default) or `in-process` (a gated multi-turn agent loop where MAF intercepts every tool call). See [In-process execution](#in-process-execution--the-tool-call-protocol) below.
- **Typed processor pipeline** — per-turn behavior (prompt assembly, secret redaction, transcript, security gate) is a bundle of hook-indexed `Processor`s with contract-enforced, permitted mutations. See `@maf/processors`.
- **Policy engine** — minimatch-based path globs, agentRole predicates, and Cypher memory-pattern queries. Three verdicts: Allow / Deny / Escalate-for-approval.
- **Memory** — KuzuDB graph for structured run history (tasks, failures, tool invocations) plus an LCM context engine for transcript compression and retrieval.
- **Automatic security gate** — every coder diff is reviewed by a security agent in parallel with the human review gate. Critical/high findings block the run (on both execution paths, regardless of run outcome).
- **Secret redaction** — genuine credential formats (API/LLM/cloud keys, tokens, private keys) are stripped from tool output before it reaches the model history, transcript, memory graph, or the signed attestation. The attestation stays **byte-faithful** except those secret substrings.
- **Attestation** — every run produces a signed in-toto bundle recording the toolchain, tool calls, approvals, security findings, diff hashes, and the content-addressed **harness** (`id` + `sha`) that produced it.
- **Harness configs** — the full "how agents behave" (role set + processor bundle + planner knobs) is a serializable, content-hashed object under `.maf/harnesses/`; every artifact is stamped with its sha. An offline evaluation harness (`goldens`) and a bounded evolution loop (`evolve`) operate on it.

## Quickstart

Requires Node ≥ 20 and [pnpm](https://pnpm.io) ≥ 8. Clone, install, build, then run:

```bash
# 1. clone
git clone https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework.git
cd Multi-Agent-Evolution-Framework

# 2. install workspace dependencies
pnpm install

# 3. build all packages (tsc project references, leaf-first)
pnpm build

# 4. (optional) run the suite — 181 tests across policy, git-ops, roles, planning,
#    attestation, tools, processors, tool-loop, harness-config, eval-harness, evolver, adapters
pnpm -r test

# 5. see the in-process gated loop run end-to-end against a throwaway fixture.
#    Deterministic by default (no network); --live drives the real `claude` binary.
node packages/cli/dist/main.js inprocess-demo
node packages/cli/dist/main.js inprocess-demo --live

# …or run an agent against a target repo (needs the chosen backend CLI installed)
node packages/cli/dist/main.js run "add a hello function" -d /path/to/repo --adapter claude
```

> Build before running: the CLI executes from compiled `dist/` (not committed), so
> steps 2–3 are required after a fresh clone. `packages/cli` also exposes a `maf` bin.

The CLI reads `.maf/config.yaml`, `.maf/policy.yaml`, and `.maf/roles.yaml` from the target directory (all optional — sensible defaults apply when missing). `maf run --harness <id|sha>` instead loads a stored harness config.

Other commands: `maf harness list|show|set-current`, `maf goldens run|compare` (score/compare harnesses against the golden corpus), `maf evolve` (offline AEGIS-lite harness evolution), `maf adapters` (availability).

## Architecture at a glance

```
                                ┌─────────────────────────┐
maf run "task" ─────────────────│  RetrievalAugmentedPlanner │
                                │  (LCM + failure context)   │
                                └──────────┬──────────────┘
                                           │ DAG with agentRole per node
                                           ▼
                                ┌─────────────────────────┐
                                │      DagRunner          │
                                └──────────┬──────────────┘
                                           │ executor(node)
                                           ▼
        ┌──────────────────────────────────────────────────────┐
        │                  RoleDispatcher                       │
        │  ┌────────┐  ┌─────────────┐  ┌────────────────┐    │
        │  │ Role   │  │ RoleTool    │  │ GraphAware     │    │
        │  │Registry│  │ Registry    │  │ Injector       │    │
        │  └────────┘  └─────────────┘  └────────────────┘    │
        └─────────┬─────────────────┬──────────────────────────┘
                  │                 │
                  ▼                 ▼
         ┌─────────────┐    ┌──────────────────┐
         │ CliAdapter  │    │ SecurityReviewGate │  (post-coder)
         └─────────────┘    └──────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │     Attestor     │  ← signed bundle
                            └──────────────────┘
```

### Packages

| Package | Purpose |
|---|---|
| `@maf/types`            | Branded IDs, shared interfaces (DagNode, ToolContext, PolicyPredicate, AttestationBundle, etc.) |
| `@maf/blackboard`       | In-process key/value store wired into LCM via `BlackboardToLcmAdapter` |
| `@maf/lcm` / `@maf/lcm-adapter` | Conversational memory: chunking, summarization, semantic recall |
| `@maf/memory-graph`     | KuzuDB-backed graph (Run / Task / Failure / ToolInvocation nodes) |
| `@maf/transcript`       | Append-only transcript with LCM flush triggers |
| `@maf/policy-engine`    | Path-glob + role + Cypher-memory predicates; Allow / Deny / Escalate verdicts |
| `@maf/approval-gate`    | Human-in-the-loop approval flow for `Escalate` verdicts |
| `@maf/prompt-injector`  | `GraphAwareInjector` assembles role-aware system prompt prefixes |
| `@maf/tools`            | Built-in tool plugins: fs.*, grep, git.*, patch.apply, test.run |
| `@maf/tool-loop`        | Shared gated executor (`executeToolGated`: policy → execute → redact → attest) + `InProcessAgentLoop` (the multi-turn in-process agent loop) |
| `@maf/processors`       | Hook-indexed typed `Processor` pipeline + contract validator; default bundle (policy-audit, secret-redact, transcript, security-gate); `redaction.ts` |
| `@maf/harness-config`   | Content-addressed `HarnessConfig` (role set + processor bundle + planner knobs), canonical sha, tamper-checking `HarnessStore` |
| `@maf/eval-harness`     | Golden corpus (required provenance), verifiers (test-script / security-gate / diff-match / llm-judge), `GoldenRunner`, pure `seesawDecision` |
| `@maf/evolver`          | Offline AEGIS-lite loop: bounded `HarnessEdit` surface, instruction screening, deterministic gate (never in the serving path) |
| `@maf/dag-runner`       | Concurrency-limited DAG executor with retry policies and review gates |
| `@maf/planning-agent`   | `RetrievalAugmentedPlanner` + `DagSynthesizer` + failure-pattern detector |
| `@maf/git-ops`          | Worktree manager, rollback, branch isolation, ReviewGate, **SecurityReviewGate** |
| `@maf/attestation`      | SLSA-style provenance + HMAC-signed bundle (stamped with the producing harness sha) |
| `@maf/roles`            | `RoleRegistry`, `RoleToolRegistry`, `RoleDispatcher` (cli/in-process gate), default role set |
| `@maf/adapters/*`       | Claude Code, Gemini, Codex, Ollama, OpenRouter CLI bindings (Claude/Codex implement the `TurnAdapter` turn protocol) |
| `@maf/cli`              | The `maf` binary (`run`, `harness`, `goldens`, `evolve`, `inprocess-demo`, `adapters`, `merge-runs`) |

## In-process execution & the tool-call protocol

By default a role runs in **`cli`** mode: MAF hands the backend CLI one prompt and reads back one opaque result — the backend runs its own tools, so MAF's policy engine and processors cannot see individual tool calls.

Set `execution: in-process` on a role (in `roles.yaml` / the harness) to instead run it through `InProcessAgentLoop` — a real multi-turn loop where **MAF drives every tool call**. A role only takes this path when the adapter both implements `TurnAdapter.sendTurn` **and** reports `capabilities().inProcessLoop === true` (today: Claude; Codex ships `sendTurn` but keeps the capability off pending a verified non-autonomous invocation). Otherwise it transparently falls back to `cli` with a warning.

Per turn, the loop:

1. Sends the conversation plus a **tool catalog advertised by tool id** (`AVAILABLE TOOLS: - fs.write [write]: …`) to the model. The model requests a tool by emitting one fenced block:
   ````
   ```tool_call
   {"toolName":"fs.write","input":{"path":"sum.js","content":"…"}}
   ```
   ````
2. Runs the 8 processor hooks (`task_start`, `step_start`, `before_model`, `after_model`, `before_tool`, `after_tool`, `step_end`, `task_end`) with contract-enforced mutations — a processor that writes a read-only field throws `ContractViolation`.
3. Dispatches each call through the shared gate: `policy.evaluate → tool.execute → redact secrets → attestor.record`. Policy always runs **after** any processor edits; a processor can narrow a tool input but never widen an allowlist.
4. Enforces `role.tokenBudget` (real usage if the adapter reports it, else a conservative estimate) and `role.maxToolIterations`.
5. Runs the coder security gate at `task_end` on **any** outcome (completed / budget-exhausted / failed) so a partial diff is never left unreviewed.

**Malformed tool-call repair (bounded).** If the model emits a `tool_call` fence that isn't valid JSON or lacks a string `toolName` — and no valid call parsed — the loop does not silently drop it. It appends the exact parser error and the required format to the conversation and retries, up to **`maxToolCallRepairs` (default 3)**. After the limit the turn fails loudly (`outcome: 'failed'`) rather than looping forever.

See it run end-to-end with `maf inprocess-demo` (deterministic scripted model) or `maf inprocess-demo --live` (real `claude`): it fixes a failing test through gated `fs.read`/`fs.write`/`test.run` calls, shows a policy-denied `fs.delete`, redacts a fake key in a read result, and writes a signed attestation.

## Configuration

All configuration lives in a `.maf/` directory inside the target repo. None of these files are required — defaults will be used if any is missing.

| File | Purpose |
|---|---|
| `.maf/policy.yaml`  | Tool/role/path rules with Allow/Deny/Escalate verdicts |
| `.maf/roles.yaml`   | Role definitions: prompt source, allowed tools, optional model/timeout |
| `.maf/prompts/*.md` | Role-specific system prompts (referenced by `roles.yaml` via `promptFile`) |
| `.maf/config.yaml`  | Adapter defaults, model overrides (read by adapter resolvers) |

See [docs/ROLES.md](docs/ROLES.md) for the role system and [docs/POLICY.md](docs/POLICY.md) for the policy predicate reference.

## Run output

A run produces:

1. **Transcripts** at `.maf/transcripts/<runId>.jsonl` — every user/assistant turn with `agentRole` tagging (secrets redacted).
2. **Memory graph** at `.maf/memory.kuzu` — persistent across runs; planner queries past failures from it. Tool-invocation nodes are stamped with the producing `harness_sha`.
3. **Harness** at `.maf/harnesses/<sha>.yaml` (+ `index.json`, `CURRENT`) — the content-addressed config that produced the run; `legacy-default` is auto-minted from `roles.yaml` when no harness is given.
4. **Attestation bundle** at `.maf/attestations/<runId>.bundle.json` — HMAC-signed via `MAF_SIGNING_KEY` (env var, defaults to `dev-secret`); names its producing harness (`id` + `sha`). Tool inputs/results are byte-faithful except redacted credential substrings. Verify with `Attestor.verify`.

## Development

```bash
pnpm build              # tsc across all packages
pnpm -r typecheck       # tsc --noEmit
pnpm -r test            # node:test on dist/__tests__/
```

TypeScript settings (see `tsconfig.base.json`): `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Branded ID types (RunId, TaskId, ToolId, NodeId, AgentId, EdgeId) — construct via the `make*` helpers in `@maf/types`.

Tests live in `src/__tests__/` and run from `dist/__tests__/`. Each package that has tests declares `"test": "node --test dist/__tests__/*.test.js"` in its `package.json`.
