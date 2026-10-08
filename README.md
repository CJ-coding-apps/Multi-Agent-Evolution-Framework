# MAF — Multi-Agent Evolution Framework

CLI-agnostic orchestration for code-modifying agents. MAF asks a model to plan a DAG of agent tasks, dispatches each node to a named role (coder, tester, security, reviewer) with its own system prompt and tool allowlist, has a security agent review the repository diff a writer role leaves, whatever the node's outcome (on the in-process tier, the end-of-task review needs the harness to keep the default `security-gate` processor), and writes an HMAC-signed, SLSA-style attestation bundle when the DAG finishes, whether or not it succeeded.

The backends sit behind one adapter interface: the Claude Code, Gemini and Codex command-line tools, and the Ollama and OpenRouter HTTP APIs.

## Status

What is true of the code as of 0.2.1. Prose elsewhere in this README describes only the *shipped* rows. **Proof** names the tests that check a shipped row; each lives under `packages/<package>/src/__tests__/` and runs in the CI job `build · typecheck · test`. **Since/Planned** is the release a shipped row first appeared in, or the release planned to ship (or, for an experimental row, to finish) it.

| Feature | Status | Since/Planned | Proof |
|---|---|---|---|
| Per-role dispatch: a system prompt and tool allowlist per DAG node; an unknown role name is refused | shipped | 0.1.0 | `roles/RoleDispatcher.test.ts`, `dag-runner/unknown-role.test.ts` |
| A node that failed or did not finish fails: a `cli`-tier result's `success` (the CLI's exit status, or the HTTP status) is checked, as is a writer's empty output; an in-process turn that times out or exits non-zero throws instead of reading as an answer; `budget_exhausted` fails unless the node sets `allowPartial` | shipped | 0.2.1 | `roles/RoleDispatcher.test.ts`, `adapters/claude/ClaudeAdapter.test.ts`, `adapters/codex/CodexAdapter.test.ts`, `adapters/base/failure.test.ts` |
| `allowPartial` set from a DAG spec or by the planner | planned | 0.3.0 | — today only a DAG built in code can set it |
| Retry for transport failures only (two attempts by default): a timeout, a CLI that exits non-zero without output or cannot start, a failed or aborted HTTP request, an HTTP 5xx, a reviewer that times out. A gate or policy refusal, an HTTP 4xx, or a non-zero exit that wrote output is never retried | shipped | 0.2.1 | `dag-runner/retry-classification.test.ts`, `roles/start-commit-cache.test.ts`, `adapters/base/ProcessSpawner.test.ts`, `adapters/openrouter/transport.test.ts`, `adapters/ollama/transport.test.ts`; the reviewer-timeout case has no test yet |
| In-process gated tool loop, opt-in per role: `cli` is the default tier in 0.2.1, and no shipped role opts in | shipped | 0.1.0 | `tool-loop/InProcessAgentLoop.test.ts`, `roles/RoleDispatcher.test.ts` |
| In-process execution by default for writer roles | planned | 0.3.0 | — |
| Typed processor pipeline with contract-enforced mutation | shipped | 0.1.0 | `processors/pipeline.test.ts` |
| Policy engine: YAML policy file, verdicts Allow / Deny / Escalate / Indeterminate, globs that match dotfiles, a file that does not load stops the run | shipped | 0.1.0 (loader 0.2.1) | `policy-engine/PolicyEngine.test.ts`, `policy-engine/PolicyEngine.more.test.ts`, `policy-engine/PolicyLoader.test.ts`, `policy-engine/shipped-policy.test.ts` |
| Path confinement to the project root | shipped | 0.2.0 | `policy-engine/path-confinement.test.ts`, `tools/fs-confinement.test.ts`, `types/paths.test.ts` |
| Approval gate for `Escalate` | planned | 0.3.0 | — today `Escalate` is refused and attested, like `Deny` |
| Secret redaction: in-process tier only, format-based and shallow | shipped | 0.1.0 | `tool-loop/InProcessAgentLoop.test.ts`, `processors/pipeline.test.ts` |
| Signed attestation bundle: MAF's own JSON format, HMAC-signed, `keySource` recorded, refused calls included; a 0.2.0 bundle verifies against the key you supply and is reported `legacy` | shipped | 0.1.0 (`keySource`, refusals and `inspect` 0.2.1) | `attestation/signing.test.ts`, `tool-loop/refusals.test.ts` |
| in-toto attestation | planned | 0.3.0 | — |
| Security gate: every writer role's diff of the whole repository (MAF's runtime state left out, its configuration kept), reviewed whole or refused, verdict from finding severities; runs on every outcome, including a backend that throws; on the in-process tier the end-of-task review needs the harness's processor bundle to include `security-gate` | shipped | 0.1.0 (reworked 0.2.1) | `git-ops/SecurityReviewGate.gate.test.ts`, `git-ops/SnapshotDiff.test.ts`, `roles/post-coder-gates.test.ts`, `processors/pipeline.test.ts` |
| Human review gate alongside the security gate | planned | 0.3.0 | — |
| Worktree isolation | planned | 0.3.0 | — today a run edits the target working tree in place; `--no-worktree` has no effect |
| `.maf/config.yaml` | planned | 0.3.0 | — not read today |
| `.maf/roles.yaml` read as YAML | planned | 0.3.0 | — today it is read as JSON, with `#` comment lines allowed |
| Memory graph (Kùzu): writes | shipped | 0.1.0 | `memory-graph/graph-parameters.test.ts` |
| Planner recall of past failures from the memory graph | planned | 0.3.0 | — the planner's query matches nothing a run writes |
| Harness configs: content-addressed, with a tamper-checking store; the sha is stamped on a run's Run and tool-invocation nodes and on its bundle | shipped | 0.1.0 | `harness-config/harness-config.test.ts` covers the store; the stamping has no test yet |
| A run's recorded harness always matches the role set it ran with | planned | 0.3.0 | — today `legacy-default` is minted once from `roles.yaml` and not re-minted when that file changes |
| LCM context engine | experimental | 0.4.0 | — no tests; summaries are a placeholder |
| Evaluation harness (`maf goldens`); needs a live adapter and a harness minted by `maf run` | shipped | 0.1.0 | `eval-harness/eval-harness.test.ts`, `cli/goldens-outcome.test.ts` |
| Offline evaluation (no model) | planned | 0.3.0 | — |
| Evolver (`maf evolve`) | experimental | 0.4.0 | `evolver/evolver.test.ts` |
| `maf inprocess-demo` (offline by default) | shipped | 0.1.0 | `cli/demo-fixture.test.ts` covers its fixture; no CI job runs the demo yet |
| Backends: Claude Code, Gemini, Codex (CLI); Ollama, OpenRouter (HTTP) | shipped | 0.1.0 | `adapters/claude/ClaudeAdapter.test.ts`, `adapters/codex/CodexAdapter.test.ts`, `adapters/gemini/GeminiAdapter.test.ts`, `adapters/openrouter/OpenRouterAdapter.test.ts`, `adapters/openrouter/transport.test.ts`, `adapters/ollama/OllamaAdapter.test.ts`, `adapters/ollama/transport.test.ts`, `adapters/base/ProcessSpawner.test.ts`; the CLI adapters are tested with a stand-in spawner, not the real binaries |
| Docker image | planned | not scheduled | — |
| npm packages (nothing is published) | planned | not scheduled | — |

## What it does

- **Per-role dispatch.** Each DAG node runs as a role with its own system prompt and tool allowlist, from the target's `.maf/roles.yaml` or the built-in role set. A role name the role set does not define is refused where the DAG is built. See [docs/ROLES.md](docs/ROLES.md).
- **Two execution tiers per role.** `cli`, the default, hands the backend one prompt and reads back one result; the backend runs its own tools. `in-process` runs a multi-turn loop in which MAF executes every tool call itself. Only the in-process tier is governed by the policy engine, the processor pipeline and redaction; see [In-process execution](#in-process-execution--the-tool-call-protocol) and [docs/SECURITY.md](docs/SECURITY.md).
- **Typed processor pipeline** (in-process tier). Per-turn behaviour is a bundle of hook-indexed `Processor`s with contract-enforced, permitted mutations; the default bundle is `policy-audit`, `secret-redact`, `transcript` and `security-gate`. See `@maf/processors`.
- **Policy engine** (in-process tier). Rules in `.maf/policy.yaml` match on tool id, role, minimatch path globs (dotfiles included) and Cypher memory-pattern queries. Verdicts are Allow, Deny, Escalate and Indeterminate, and only Allow runs the tool: in 0.2.1 Escalate is refused just as Deny is. Every path a tool declares is confined to the project root before any rule is read. See [docs/POLICY.md](docs/POLICY.md).
- **Security gate.** Every role that holds a write tool has its change reviewed by a security agent, as one diff of the whole repository — even when `-d` names a subdirectory — against the commit the node started from. Only this run's runtime state under `.maf/` (transcripts, bundles, the memory graph and the like) is left out; MAF's configuration there (`policy.yaml`, `roles.yaml`, `config.yaml`, `prompts/`) is reviewed like any other file ([D-29](docs/DECISIONS.md)). A diff longer than the gate's cap (60,000 characters by default) fails the node instead of being cut short. A critical or high finding fails the node whatever the reviewer's own `passed` field says; a reviewer that times out is a transport failure, retried, not a refusal. The review runs whatever the node's outcome: on success, on failure, on an exhausted budget, and when the backend or the in-process loop throws, in which case a refusal outranks the error ([D-31](docs/DECISIONS.md)). On the in-process tier the end-of-task review is the `security-gate` processor, which the default bundle includes; a harness whose processor bundle leaves it out is reviewed only when the loop throws.
- **Secret redaction** (in-process tier). Eight credential formats (API/LLM/cloud keys, tokens, private keys) are stripped from tool results before the model sees them, and from tool inputs and results before they reach the memory graph or the attestation bundle. It is format-based and shallow: only top-level string values of a tool's input are scrubbed, and the bundle is byte-faithful apart from the matched substrings.
- **Attestation.** At the end of a run MAF writes an HMAC-signed JSON bundle in its own SLSA-style format. It records the adapter, the `--model` given, the harness (`id` + `sha`), every in-process tool call (refused calls included, with the verdict and, where a rule decided, its id), the security findings, the run outcome, and `keySource` (`env` or `dev`) inside the signed payload.
- **Memory graph.** A Kùzu database at `.maf/memory.kuzu` records each run, every node that failed (with its error or its security findings) and every in-process tool call.
- **Harness configs.** The role set, processor bundle and planner knobs form one serializable, content-hashed object under `.maf/harnesses/`; a run's Run node, its tool-invocation nodes and its bundle carry its sha. `maf goldens` scores a harness against a golden corpus using a live model.

## Quickstart

### Prerequisites

- **Node 22.** It is the version CI builds and tests on.
- **pnpm 8.15.1**, through corepack: `corepack enable` provides the version named in `package.json`'s `packageManager` field.
- **git.** The target directory of `maf run` must be a git repository: a writer role's change is reviewed as a diff against the commit the node started from.
- **npm.** `test.run`, and so the demo, runs `npm test` in a project where it recognises no other test runner.
- **Native modules.** `kuzu` (0.7.1) and `better-sqlite3` (11.x) need a prebuilt binary for your platform and Node version; where none exists, installing them means compiling from source, which needs a C++ toolchain.
- No browser and no `playwright` install is needed.

### Build and run

```bash
# 1. clone
git clone https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework.git
cd Multi-Agent-Evolution-Framework

# 2. install workspace dependencies with the pinned pnpm
corepack enable
pnpm install --frozen-lockfile

# 3. build: each package runs its own tsc, in dependency order
pnpm build

# 4. (optional) run the test suites
pnpm -r test

# 5. watch the in-process gated loop run end-to-end against a throwaway fixture.
#    Deterministic and offline by default; --live drives the real `claude` binary.
node packages/cli/dist/main.js inprocess-demo
node packages/cli/dist/main.js inprocess-demo --live

# 6. run an agent against a target git repository (needs the chosen backend)
export MAF_SIGNING_KEY='<a secret you keep>'   # see "Before maf run" below
node packages/cli/dist/main.js run "add a hello function" -d /path/to/repo --adapter claude
```

> The CLI runs from compiled `dist/`, which is not committed, so steps 2–3 are required after a
> fresh clone. This README writes `maf <command>` for `node packages/cli/dist/main.js <command>`:
> nothing is published to npm, and nothing in this repository puts `packages/cli`'s `maf` bin on
> your `PATH`.

Before `maf run`:

- **Set `MAF_SIGNING_KEY`** to a secret of your own, or the bundle is evidence of nothing. Without it, `run` prints one warning line to stderr, signs with the public development key, and the bundle records `keySource: "dev"`. The key is not hidden from the agent; see [docs/SECURITY.md](docs/SECURITY.md).
- **Pick a backend.** `--adapter claude|gemini|codex` needs that CLI on your `PATH`. `--adapter openrouter` needs `OPENROUTER_API_KEY`; `--adapter ollama` needs an Ollama server (`OLLAMA_BASE_URL`, default `http://localhost:11434`). Neither HTTP adapter has a default model: set `OPENROUTER_MODEL` or `OLLAMA_MODEL`, or pass `--model`, or the first model call is refused before it is sent.
- **Expect your working tree to change.** A run works directly in the target directory, on its current branch. Commit or stash first.

`run` reads `.maf/policy.yaml` and `.maf/roles.yaml` from the target directory (`--policy` and `--roles` take other paths, resolved against it) and creates `.maf/` if it is missing.

- A missing policy file prints one warning and the run proceeds with no rules; path confinement still applies. A policy file that exists but is not valid YAML, or fails validation, stops the run with the error.
- Policy files are YAML, and JSON parses too. Quote every glob: YAML reads a bare value starting with `*` as an alias and one starting with `{` as a mapping.
- `roles.yaml` is read as JSON, with `#` comment lines allowed. If it is missing, the built-in roles apply; if it exists but does not parse, the run stops.
- `.maf/config.yaml` is not read.

`maf run --harness <id|sha|current>` loads a stored harness instead of `roles.yaml`.

Other commands: `maf harness list|show|set-current`, `maf goldens run|compare` (score and compare harnesses against the golden corpus with a live adapter; `goldens run` starts from a harness that `maf run` has minted), `maf evolve` (experimental, see Status), `maf adapters` (availability), `maf merge-runs`.

## Architecture at a glance

```
        maf run "task"
               │
               ▼
┌──────────────────────────────┐
│  RetrievalAugmentedPlanner   │  the model writes the plan; role names are checked
└──────────────┬───────────────┘
               │ DAG with one agentRole per node
               ▼
┌──────────────────────────────┐
│          DagRunner           │  writer lock, transport-only retry
└──────────────┬───────────────┘
               │ executor(node)
               ▼
┌───────────────────────────────────────────────────────┐
│                    RoleDispatcher                     │
│  RoleRegistry · RoleToolRegistry · GraphAwareInjector │
└──────┬─────────────────────────────┬──────────────────┘
       │ cli tier (default)          │ in-process tier
       ▼                             ▼
┌──────────────┐        ┌───────────────────────────────┐
│  CliAdapter  │        │      InProcessAgentLoop       │
│   invoke()   │        │ processors · executeToolGated │
└──────┬───────┘        └───────────────┬───────────────┘
       │ writer roles                   │ writer roles, at task_end
       ▼                                ▼
     ┌────────────────────────────────────────┐
     │           SecurityReviewGate           │
     └───────────────────┬────────────────────┘
                         ▼
     ┌────────────────────────────────────────┐
     │      Attestor  →  signed bundle        │
     └────────────────────────────────────────┘
```

### Packages

| Package | Purpose |
|---|---|
| `@maf/types`            | Branded IDs, shared interfaces (DagNode, ToolContext, PolicyPredicate, AttestationBundle, etc.), the error classes the scheduler classifies by (`TransportError`, `VerdictError`, `NodeFailure`, `GateRefused`), and `resolveInside` path confinement. The one package that is not types-only: `paths.ts` reads the filesystem at run time, deliberately, because the tools and the policy engine both need the primitive and neither may depend on the other |
| `@maf/blackboard`       | In-process key/value store wired into LCM via `BlackboardToLcmAdapter` |
| `@maf/lcm` / `@maf/lcm-adapter` | Experimental: a SQLite transcript store with compaction and keyword recall; the summaries `maf run` gives it are a placeholder (the first 200 characters of each message) |
| `@maf/memory-graph`     | Kùzu-backed graph with bound query parameters (Run, Failure, ToolInvocation, GoldenResult, EvolutionRound nodes) |
| `@maf/transcript`       | Append-only JSONL transcript with LCM flush triggers |
| `@maf/policy-engine`    | `PolicyLoader` (validating YAML loader) and `PolicyEngine`: path-glob, role and Cypher-memory predicates; Allow / Deny / Escalate / Indeterminate |
| `@maf/approval-gate`    | An approval flow for `Escalate` verdicts. Not used by `maf run` in 0.2.1, where `Escalate` is refused |
| `@maf/prompt-injector`  | `GraphAwareInjector` assembles role-aware system prompt prefixes |
| `@maf/tools`            | Built-in tool plugins: fs.*, grep, git.*, patch.apply, test.run |
| `@maf/tool-loop`        | `executeToolGated`, the one gated executor (policy; a refusal is attested and thrown; otherwise execute → redact → attest), and `InProcessAgentLoop`, the multi-turn in-process agent loop. `ToolLoop`, `PatchTestCycle` and `CircuitBreaker` are also here and are not used by `maf run` |
| `@maf/processors`       | Hook-indexed typed `Processor` pipeline + contract validator; default bundle (policy-audit, secret-redact, transcript, security-gate); `redaction.ts` |
| `@maf/harness-config`   | Content-addressed `HarnessConfig` (role set + processor bundle + planner knobs), canonical sha, tamper-checking `HarnessStore` |
| `@maf/eval-harness`     | Golden corpus (required provenance), verifiers (test-script / security-gate / diff-match / llm-judge), `GoldenRunner`, pure `seesawDecision` |
| `@maf/evolver`          | Experimental: an AEGIS-lite loop over a bounded `HarnessEdit` surface, with instruction screening and a deterministic gate (never in the serving path) |
| `@maf/dag-runner`       | Concurrency-limited DAG executor: one writer at a time, retry for transport failures only. Its `reviewGateNodeIds` setting is not acted on |
| `@maf/planning-agent`   | `RetrievalAugmentedPlanner`, `DagSynthesizer`, and a failure-pattern detector whose query matches nothing a run writes yet |
| `@maf/git-ops`          | **SecurityReviewGate**, `snapshotDiff`, `runIsolatedGit`; also `WorktreeManager`, `BranchIsolator`, `RollbackManager` and `ReviewGate`, which `maf run` does not use in 0.2.1 |
| `@maf/attestation`      | SLSA-style provenance + HMAC-signed bundle carrying its `keySource` (stamped with the producing harness sha); `Attestor.verify` / `Attestor.inspect` and `BundleSigner` apply the same `keySource` rule |
| `@maf/roles`            | `RoleRegistry`, `RoleToolRegistry`, `RoleDispatcher` (cli/in-process dispatch, node verdicts, post-task security gate), `isWriterRole`, default role set |
| `@maf/adapters/*`       | Claude Code, Gemini and Codex CLI bindings; Ollama and OpenRouter HTTP adapters (Claude and Codex implement the `TurnAdapter` turn protocol) |
| `@maf/cli`              | The `maf` command (`run`, `harness`, `goldens`, `evolve`, `inprocess-demo`, `adapters`, `merge-runs`) |

## In-process execution & the tool-call protocol

By default a role runs in **`cli`** mode: MAF hands the backend CLI one prompt and reads back one opaque result. The backend runs its own tools, and the role's tool allowlist is not passed to it, so MAF's policy engine and processors see no individual tool call. No role in the built-in set or in this repository's `.maf/roles.yaml` changes that default.

Set `execution: in-process` on a role (in `roles.yaml` / the harness) to instead run it through `InProcessAgentLoop`, a real multi-turn loop where **MAF drives every tool call**. A role only takes this path when the adapter both implements `TurnAdapter.sendTurn` **and** reports `capabilities().inProcessLoop === true` (today: Claude; Codex ships `sendTurn` but keeps the capability off pending a verified non-autonomous invocation). Otherwise it falls back to `cli`, and the fallback is noted in the run's transcript.

Per turn, the loop:

1. Sends the conversation plus a **tool catalog advertised by tool id** (`AVAILABLE TOOLS: - fs.write [write]: …`) to the model. The model requests a tool by emitting one fenced block:
   ````
   ```tool_call
   {"toolName":"fs.write","input":{"path":"sum.js","content":"…"}}
   ```
   ````
2. Runs the 8 processor hooks (`task_start`, `step_start`, `before_model`, `after_model`, `before_tool`, `after_tool`, `step_end`, `task_end`) with contract-enforced mutations: a processor that writes a read-only field, in place or on a copy, throws `ContractViolation`.
3. Answers a call to a tool outside the role's allowlist with an error, before policy. Every other call goes through `executeToolGated`: `policy.evaluate`, then either the refusal is attested and the model is told why (any verdict but Allow), or `tool.execute → redact secrets → attestor.record`. Policy always runs **after** any processor edits; a processor can narrow a tool input but never widen an allowlist.
4. Enforces `role.tokenBudget` (real usage if the adapter reports it, else a conservative estimate) and `role.maxToolIterations`. A loop that hits either ends `budget_exhausted`, which fails the node unless the node sets `allowPartial: true`. Only a DAG built in code can set `allowPartial` in 0.2.1; DAG specs and the planner cannot yet (see Status).
5. Runs the security gate for a writer role at `task_end` on **any** outcome the loop returns (completed / budget-exhausted / failed), so a partial diff is never left unreviewed. The `security-gate` processor in the default bundle does this; a harness whose processor bundle leaves it out gets no end-of-task review. If the loop throws instead — a turn that timed out, a backend that never started — it never reaches `task_end`, and the dispatcher runs the same review before the error propagates.

A turn whose backend times out, cannot start, or exits non-zero without writing anything throws the spawner's `TransportError`, so the node may be retried; a turn that exits non-zero after writing output throws an `Error` naming the exit code, with a masked stderr tail, and is not retried. Neither is read as an answer.

**Malformed tool-call repair (bounded).** If the model emits a `tool_call` fence that isn't valid JSON or lacks a string `toolName`, and no valid call parsed, the loop does not silently drop it. It appends the exact parser error and the required format to the conversation and retries, up to **`maxToolCallRepairs` (default 3)**. After the limit the turn fails loudly (`outcome: 'failed'`, and the node fails) rather than looping forever.

See it run end-to-end with `maf inprocess-demo` (deterministic scripted model) or `maf inprocess-demo --live` (real `claude`): it fixes a failing test through gated `fs.read`/`fs.write`/`test.run` calls, shows a policy-denied `fs.delete`, redacts a fake key in a read result, and writes a signed attestation.

## Configuration

Configuration lives in a `.maf/` directory inside the target repo, which `run` creates if it is missing.

| File | Purpose |
|---|---|
| `.maf/policy.yaml`  | Tool/role/path rules (YAML; JSON parses too). Missing: one warning, no rules. Present but invalid: the run stops |
| `.maf/roles.yaml`   | Role definitions: prompt source, allowed tools, optional model/timeout. Read as JSON with `#` comment lines allowed. Missing: the built-in roles. Present but unparseable: the run stops |
| `.maf/prompts/*.md` | Role-specific system prompts (referenced by `roles.yaml` via `promptFile`) |
| `.maf/config.yaml`  | Not read in 0.2.1 (see Status); values in it have no effect |

See [docs/ROLES.md](docs/ROLES.md) for the role system, [docs/POLICY.md](docs/POLICY.md) for the policy predicate reference, and [docs/SECURITY.md](docs/SECURITY.md) for what the security gate reads — including what it does not.

## Run output

A run produces:

1. **Transcripts** at `.maf/transcripts/<runId>.jsonl`: every user/assistant turn, tagged with `agentRole`. They are not scrubbed as a whole: what the backend or the model wrote is recorded as written.
2. **Memory graph** at `.maf/memory.kuzu`, persistent across runs: the run, its failed nodes, and its in-process tool invocations, which are stamped with the producing `harness_sha`.
3. **Harness** at `.maf/harnesses/<sha>.yaml` (+ `index.json`, `CURRENT`): the content-addressed config. Without `--harness`, a run records `legacy-default`, minted from `roles.yaml` the first time and reused after that.
4. **Attestation bundle** at `.maf/attestations/<runId>.bundle.json`: HMAC-SHA256 over the bundle's JSON, keyed by `MAF_SIGNING_KEY`. With that unset, the run warns once on stderr, signs with the public development key, and the bundle says `keySource: "dev"`; `run` prints the `keySource` beside the signature. Tool inputs and results are byte-faithful except redacted credential substrings. Check a bundle from `@maf/attestation` (there is no `maf` command for it): `Attestor.verify(bundle, { secret })` returns `true` only when the signature matches that key and the bundle's `keySource` names it; `Attestor.inspect(bundle, { secret })` returns `{ valid, keySource, legacy }`. A bundle written by 0.2.0 has no `keySource`: it verifies on its signature against whatever key you supply, and `inspect` reports it as `legacy: true`.

## Development

```bash
pnpm build              # each package's own tsc, in dependency order
pnpm -r typecheck       # tsc --noEmit
pnpm -r test            # node:test on dist/__tests__/
```

TypeScript settings (see `tsconfig.base.json`): `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Branded ID types (RunId, TaskId, ToolId, NodeId, AgentId, EdgeId) — construct via the `make*` helpers in `@maf/types`.

Tests live in `src/__tests__/` and run from `dist/__tests__/`. Each package that has tests declares `"test": "node --test dist/__tests__/*.test.js"` in its `package.json`.

## Acknowledgements

The processor pipeline, and three of MAF's designs, follow **HarnessX**
(Darwin Agent Team) — *HarnessX: A Composable, Adaptive, and Evolvable Agent
Harness Foundry* ([arXiv:2606.14249](https://arxiv.org/abs/2606.14249)) and its
MIT-licensed codebase
([Darwin-Agent/HarnessX](https://github.com/Darwin-Agent/HarnessX)):

- the typed, hook-indexed **processor pipeline** with contract-enforced event
  mutation (`@maf/processors`) — its hooks, event types and mutation contract
  correspond to HarnessX's core, and the implementation is an independent
  TypeScript one;
- the **seesaw acceptance rule** — a candidate ships only if it improves
  something and regresses nothing (`seesawDecision` in `@maf/eval-harness`);
- the trace-driven **evolution loop** behind `maf evolve` (`@maf/evolver`).
  HarnessX names its evolution engine AEGIS, which is why `maf evolve` is
  described as an "AEGIS-lite" loop: it keeps the design and narrows it, mutating
  configuration only — role prompts, tool allowlists, model bindings, budgets,
  which known processors a bundle composes — and never processor source.

The second and third are paper-level designs: neither those names nor those
mechanisms appear in the HarnessX codebase. What MAF borrows throughout is the
design, not the code. See [`NOTICE`](NOTICE) for what corresponds to what, and
for HarnessX's MIT license.
