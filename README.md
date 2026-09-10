# MAF — Multi-Agent Framework

CLI-agnostic orchestration for code-modifying agents. MAF plans a DAG of agent tasks, dispatches each node to a named role (coder, tester, security, reviewer) with its own tool allowlist and policy bindings, and emits a signed SLSA-style attestation bundle for every run.

The framework wraps any of several backend LLM CLIs — Claude Code, Gemini, Codex, Ollama, or OpenRouter — behind a single adapter interface, then layers:

- **Per-role dispatch** — each DAG node runs as a specific role with its own system prompt, allowed tools, and policy rules. See [docs/ROLES.md](docs/ROLES.md).
- **Policy engine** — minimatch-based path globs, agentRole predicates, and Cypher memory-pattern queries. Three verdicts: Allow / Deny / Escalate-for-approval.
- **Memory** — KuzuDB graph for structured run history (tasks, failures, tool invocations) plus an LCM context engine for transcript compression and retrieval.
- **Automatic security gate** — every coder diff is reviewed by a security agent in parallel with the human review gate. Critical/high findings block the run.
- **Attestation** — every run produces a signed in-toto bundle recording the toolchain, tool calls, approvals, security findings, and diff hashes.

## Quickstart

```bash
pnpm install
pnpm build
pnpm -r test            # 110 unit tests across policy, git-ops, roles, planning, attestation, tools

# Run an agent in a target directory
./packages/cli/dist/main.js run "add a hello function" -d /path/to/repo --adapter claude
```

The CLI reads `.maf/config.yaml`, `.maf/policy.yaml`, and `.maf/roles.yaml` from the target directory (all optional — sensible defaults apply when missing).

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
| `@maf/tool-loop`        | Tool execution loop with policy enforcement at `executeTool` |
| `@maf/dag-runner`       | Concurrency-limited DAG executor with retry policies and review gates |
| `@maf/planning-agent`   | `RetrievalAugmentedPlanner` + `DagSynthesizer` + failure-pattern detector |
| `@maf/git-ops`          | Worktree manager, rollback, branch isolation, ReviewGate, **SecurityReviewGate** |
| `@maf/attestation`      | SLSA-style provenance + HMAC-signed bundle |
| `@maf/roles`            | `RoleRegistry`, `RoleToolRegistry`, `RoleDispatcher`, default role set |
| `@maf/adapters/*`       | Claude Code, Gemini, Codex, Ollama, OpenRouter CLI bindings |
| `@maf/cli`              | The `maf` binary |

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

1. **Transcripts** at `.maf/transcripts/<runId>.jsonl` — every user/assistant turn with `agentRole` tagging.
2. **Memory graph** at `.maf/memory.kuzu` — persistent across runs; planner queries past failures from it.
3. **Attestation bundle** at `.maf/attestations/<runId>.bundle.json` — HMAC-signed via `MAF_SIGNING_KEY` (env var, defaults to `dev-secret`). Verify with `Attestor.verify`.

## Development

```bash
pnpm build              # tsc across all packages
pnpm -r typecheck       # tsc --noEmit
pnpm -r test            # node:test on dist/__tests__/
```

TypeScript settings (see `tsconfig.base.json`): `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Branded ID types (RunId, TaskId, ToolId, NodeId, AgentId, EdgeId) — construct via the `make*` helpers in `@maf/types`.

Tests live in `src/__tests__/` and run from `dist/__tests__/`. Each package that has tests declares `"test": "node --test dist/__tests__/*.test.js"` in its `package.json`.
