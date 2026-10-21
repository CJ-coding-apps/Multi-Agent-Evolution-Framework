# MAF — Multi-Agent Evolution Framework

CLI-agnostic orchestration for code-modifying agents. MAF asks a model to plan a DAG of agent tasks and dispatches each node to a named role (coder, tester, security, reviewer, analyst) with its own system prompt and tool allowlist. A role that holds a write tool runs by default in MAF's governed in-process loop, where every tool call passes the policy engine and is attested. Each run works in its own git worktree and branch and hands the result back as a merge command. A security agent reviews the repository diff every writer role leaves, whatever the node's outcome; a person can be asked to approve escalated tool calls and each writer's change. When the DAG finishes, whether or not it succeeded, MAF writes a signed in-toto attestation.

The backends sit behind one adapter interface: the Claude Code, Gemini and Codex command-line tools, and the Ollama and OpenRouter HTTP APIs. Only the Claude adapter can run the governed in-process loop.

## Status

What is true of the code as of 0.5.0. Prose elsewhere in this README describes only the *shipped* rows. **Proof** names the tests that check a shipped row; each lives under `packages/<package>/src/__tests__/` and runs in the CI job `build · typecheck · test`, unless it is a script named here, which the CI job `package · npm pack · install · run` runs. **e2e** marks a row the CI job `e2e · demo · attestation · offline goldens` also exercises, by running the built CLI. **Since/Planned** is the release a shipped row first appeared in, or the release planned to ship (or, for an experimental row, to finish) it.

| Feature | Status | Since/Planned | Proof |
|---|---|---|---|
| Per-role dispatch: a system prompt and tool allowlist per DAG node; an unknown role name is refused | shipped | 0.1.0 | `roles/RoleDispatcher.test.ts`, `dag-runner/unknown-role.test.ts` |
| A node that failed or did not finish fails: a `cli`-tier result's `success` (the CLI's exit status, or the HTTP status) is checked, as is a writer's empty output; an in-process turn that times out or exits non-zero throws instead of reading as an answer; `budget_exhausted` fails unless the node sets `allowPartial` | shipped | 0.2.1 | `roles/RoleDispatcher.test.ts`, `adapters/claude/ClaudeAdapter.test.ts`, `adapters/codex/CodexAdapter.test.ts`, `adapters/base/failure.test.ts` |
| The run outcome names each failed node's failure as a value ([D-46](docs/DECISIONS.md)): `RunOutcome.nodes[].failure` is `{ kind, ruleId?, toolId? }` — the kind the dispatcher decided, the rule id a policy refusal named (and, for a dispatcher refusal, the tool id) — where a node previously carried only a message; a plain `Error` (a transport or programming failure with no verdict) leaves `failure` absent rather than inventing a kind | shipped | 0.4.0 | `dag-runner/run-outcome.test.ts` |
| The governed tool protocol states what is true of the turn ([D-46](docs/DECISIONS.md)): the first paragraph of the in-process `TOOL_PROTOCOL` block tells the model the host's own tools — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, any other it may believe it has — are not available this turn and a request for one is refused, so the prompt matches the `--tools ""` spawn ([D-33](docs/DECISIONS.md)) instead of leaving the model to ask for a tool it cannot have | shipped | 0.4.0 | `adapters/base/turnProtocol.test.ts` |
| A role that expects a change (`expectsChange`; in the built-in set, `coder`) fails with `no_change` when its node answers and leaves the tree as it found it, on either tier: a `cli`-tier backend that exits 0, or an in-process loop that completes — after its tool calls failed, or with none ([D-32](docs/DECISIONS.md)) | shipped | 0.3.0 | `roles/no-change.test.ts` ("an in-process coder whose calls all fail, and that then answers in text, fails with no_change…") |
| A role that does not expect a change (`expectsChange` is not true) — the built-in readers and the `tester` — that answers after **no executed tool call** on the `in-process` tier fails with `no_work` ([D-46](docs/DECISIONS.md)): a role that made no call did not do its job; a call that **ran** — one allowed, or an `Escalate` the approval gate approved — is work, while a `Deny`, an unapproved `Escalate` and an `Indeterminate` never ran; the message names the role, the turn count and the answer's first 200 characters (credentials masked, whitespace collapsed); a role whose job is not to call a tool opts out with `expectsToolCalls: false` | shipped | 0.4.0 | `roles/no-work.test.ts` |
| `allowPartial` set from a DAG spec or by the planner | planned | not scheduled | — only a DAG built in code can set it; this did not land in 0.3.0 |
| Retry for transport failures only (two attempts by default): a timeout, a CLI that exits non-zero without output or cannot start, a failed or aborted HTTP request, an HTTP 5xx, a reviewer that times out. A gate or policy refusal, an HTTP 4xx, or a non-zero exit that wrote output is never retried | shipped | 0.2.1 | `dag-runner/retry-classification.test.ts`, `roles/start-commit-cache.test.ts`, `adapters/base/ProcessSpawner.test.ts`, `adapters/openrouter/transport.test.ts`, `adapters/ollama/transport.test.ts`; the reviewer-timeout case has no test yet |
| In-process gated tool loop | shipped | 0.1.0 | `tool-loop/InProcessAgentLoop.test.ts`, `roles/RoleDispatcher.test.ts` |
| In-process by default for writer roles ([D-01](docs/DECISIONS.md)): a role holding a write tool runs in-process unless it sets `execution: cli`; a writer that would land on the `cli` tier — by that setting, or because the adapter cannot run the loop — is refused before planning unless `--allow-ungoverned` is given, which prints an `UNGOVERNED` banner; a *custom* read-only role stays on the `cli` tier (the built-in readers ask for `in-process`) | shipped | 0.3.0 | `roles/tier-default.test.ts`, `cli/run-tiers.test.ts`, `cli/run-settings.test.ts`, `cli/run-concurrency.test.ts` |
| A fifth built-in role, `analyst` ([D-43](docs/DECISIONS.md)): read-only, holds the seven read tools and no write tool, answers a question about the code and makes no change, so a plan that asks for an investigation has a route that is neither the writer `coder` nor a diff-reviewer; the planner's role block tags every role by what it does to the tree, from the role's own tools and never its name | shipped | 0.4.0 | `roles/phase-3-readers.test.ts`, `cli/planner-role-block.test.ts`, `planning-agent/RetrievalAugmentedPlanner.test.ts` |
| The built-in readers — `security`, `reviewer`, `analyst` — run in-process by default ([D-44](docs/DECISIONS.md)): on the `cli` tier a read-only role is handed the backend's own file tools, so an audit or a review that only reads is governed in-process instead of merely observed; a custom read-only role is unchanged, and a fallback to `cli` on an adapter without the loop is recorded in the bundle's `executionTiers` | shipped | 0.4.0 | `roles/tier-default.test.ts`, `cli/run-tiers.test.ts` |
| Every role call is in the record ([D-45](docs/DECISIONS.md)): a `cli`-tier role call records a `modelSurface` — its `tier`, the `nativeTools` posture asked of the backend, and the digests of the system prompt, prompt and output — so the record covers the backend's own tools and not only the governed in-process steps; and a reader whose turn showed a change has it attributed, with the three working-tree ids and the diff's digest, to a concurrent writer whose own gate read it, or the node fails `unexpected_change` when the rule can settle it on no writer | shipped | 0.4.0 | `cli/run-attribution.test.ts`, `dag-runner/writer-lock-ledger.test.ts`, `attestation/Attestor.test.ts` |
| A `no_change` message names the rules that refused the node's own calls (F10): a writer that changed nothing having had its `Deny` or unapproved `Escalate` refused reads apart from one that lost its nerve — appended as `; N tool call(s) were denied or refused by policy: <ruleId> (<toolId>)…`, read per node from the attestor's records for that task | shipped | 0.4.0 | `roles/no-change.test.ts`, `roles/RoleDispatcher.test.ts` |
| Backend isolation: an in-process turn spawns `claude` with its built-in tools off (`--tools ""`) and no MCP servers ([D-33](docs/DECISIONS.md)); on the `cli` tier `claude` gets the same empty MCP set, `gemini` an MCP allowlist that names no configured server, and `codex` no MCP flag | shipped | 0.3.0 | `adapters/claude/ClaudeAdapter.test.ts`, `adapters/gemini/GeminiAdapter.test.ts`, `adapters/codex/CodexAdapter.test.ts`; the argv is checked against a stand-in spawner, not a live binary |
| Typed processor pipeline with contract-enforced mutation | shipped | 0.1.0 | `processors/pipeline.test.ts` |
| Policy engine: YAML policy file, verdicts Allow / Deny / Escalate / Indeterminate, globs that match dotfiles, a file that does not load stops the run | shipped | 0.1.0 (loader 0.2.1) | `policy-engine/PolicyEngine.test.ts`, `policy-engine/PolicyEngine.more.test.ts`, `policy-engine/PolicyLoader.test.ts`, `policy-engine/shipped-policy.test.ts` |
| Path confinement to the project root | shipped | 0.2.0 | `policy-engine/path-confinement.test.ts`, `tools/fs-confinement.test.ts`, `types/paths.test.ts` |
| Approval gate for `Escalate` ([D-02](docs/DECISIONS.md)): on a terminal the operator is shown the call and approves it by typing a code made for that request; with no terminal, or `MAF_HEADLESS=1`, the call is refused and written to `.maf/approvals/pending/<id>.json`; every decision is bound to a hash of the request and attested | shipped | 0.3.0 | `approval-gate/ApprovalGate.test.ts`, `approval-gate/tty.test.ts`, `approval-gate/headless.test.ts`, `approval-gate/requestHash.test.ts`, `tool-loop/approval.test.ts`, `cli/approval-gate-wired.test.ts`, `cli/approval-gate-stack.test.ts`, `cli/inprocess-demo.test.ts` |
| Secret redaction: in-process tier only, format-based and shallow | shipped | 0.1.0 | `tool-loop/InProcessAgentLoop.test.ts`, `processors/pipeline.test.ts` |
| Signed attestation bundle: HMAC-SHA256, `keySource` inside the signed payload, refused tool calls included | shipped | 0.1.0 (`keySource` and refusals 0.2.1) | `attestation/signing.test.ts`, `tool-loop/refusals.test.ts` |
| in-toto attestation: the bundle is an in-toto Statement whose subjects are the writer nodes' diffs, signed over its RFC 8785 bytes ([D-36](docs/DECISIONS.md)); `maf attest verify` checks one; a 0.2.x bundle (MAF's own JSON) still verifies against the key you supply and is reported `legacy` | shipped | 0.3.0 | `attestation/intoto.test.ts`, `attestation/jcs.test.ts`, `roles/diff-subject.test.ts`, `cli/attest.test.ts`; e2e |
| Security gate: every writer role's diff of the whole repository (MAF's runtime state left out, its configuration kept), as text whatever `.gitattributes` says, reviewed whole or refused, verdict from finding severities; runs once per attempt on every outcome, on either tier, including a backend that throws | shipped | 0.1.0 (reworked 0.2.1; in-process without the `security-gate` processor 0.3.0) | `git-ops/SecurityReviewGate.gate.test.ts`, `git-ops/SnapshotDiff.test.ts`, `git-ops/SnapshotDiff.attributes.test.ts`, `roles/post-coder-gates.test.ts`, `roles/tier-default.test.ts`, `processors/pipeline.test.ts` |
| A role that holds no write tool has its turn diffed too (F7): every node, on both tiers, brackets its turn with two working-tree snapshots and diffs those, so a non-writer whose *own* turn changed the tree fails with `unexpected_change`, the mirror of `no_change`, the change recorded as a subject of the run's attestation; on `claude` a `cli`-tier reader is given only the reading tools, while `codex` and `gemini` have no such flag and this diff guard is their only defence; the bundle records each node's tier and any fallback ([D-06](docs/DECISIONS.md)) | shipped | 0.3.1 | `roles/RoleDispatcher.test.ts`, `roles/tier-default.test.ts`, `adapters/claude/ClaudeAdapter.test.ts`; the `claude` argv is checked against a stand-in spawner, not a live binary |
| Human review gate ([D-34](docs/DECISIONS.md)): with `--review`, or a harness that sets `reviewGate: { required: true }`, each writer change the security gate passed is put to a reviewer at the terminal; a required review refuses what is not approved, and refuses every writer change when no one can be asked | shipped | 0.3.0 | `git-ops/ReviewGate.test.ts`, `roles/review-gate.test.ts`, `harness-config/review-gate-setting.test.ts`, `cli/tty-reviewer.test.ts`, `cli/run-review.test.ts`, `cli/run-review-tty.test.ts`, `cli/run-acceptance.test.ts` |
| Worktree isolation ([D-03](docs/DECISIONS.md)): a run works in `.maf/worktrees/<runId>` on a new branch `maf/<runId>` from HEAD and prints `git merge maf/<runId>` instead of merging; a failed run keeps its worktree; a branch that commits MAF's runtime state is offered no merge ([D-35](docs/DECISIONS.md)); the agent's file and git tools cannot reach your checkout from the worktree; `--no-worktree` runs in place after a warning | shipped | 0.3.0 | `git-ops/WorktreeManager.test.ts`, `git-ops/WorktreeManager.isolation.test.ts`, `cli/worktree-escape.test.ts`, `cli/run-acceptance.test.ts`, `cli/run-worktree.test.ts`, `cli/run-handover.test.ts`, `cli/run-inplace.test.ts`, `cli/run-failure.test.ts` |
| `.maf/config.yaml` read and validated: flag > file > built-in default, per key; an unknown key or a bad value stops the run | shipped | 0.3.0 | `cli/ConfigLoader.test.ts`, `cli/resolveConfig.test.ts`, `cli/run-config.test.ts`, `cli/run-settings.test.ts`, `cli/run-inplace.test.ts` |
| `.maf/roles.yaml` read as YAML (the JSON form still loads); a file that exists but does not load stops the run | shipped | 0.3.0 | `roles/roles-file-loading.test.ts`, `policy-engine/parseYamlDocument.test.ts` |
| `maf run` on a repository with no `.maf/` | shipped | 0.2.1 | `cli/ensureMafDir.test.ts`, `cli/run-acceptance.test.ts` (whose repository has no `.maf/`) |
| `maf init` sets a repository up for a run: it writes the package's own `.maf/` — policy, roles, config, prompts and the default harness — plus the `.gitignore` that keeps runtime state out of the user's history; only the policy is also what `run` falls back to when the file is absent (with no `roles.yaml`, `run` uses the built-in role set, which is not the shipped one, and says so); a second run keeps every file the user has edited and names it, `--force` replaces them, a symlink where `init` would write is refused with or without `--force`, and a directory that is not a committed work tree (including `.git` itself) is refused before anything is written | shipped | 0.5.0 | `cli/init.test.ts`, `cli/assets.test.ts` |
| A run with no policy file is governed by the built-in policy ([D-49](docs/DECISIONS.md)): with no `--policy` flag and no `.maf/policy.yaml`, `run` applies the policy shipped in the package (the repository's own `.maf/policy.yaml`, byte for byte), prints one line naming it, and records `policyInForce.sourceKind: "built-in"` with no `source` path and the shipped text's `sha256`; `--policy none` opts out and records `sourceKind: "none"`; a typed `--policy <path>` that names no file stops the run instead of running ungoverned, and a named or default file that exists but does not load still stops it, so a broken policy never falls back silently; `run`, `goldens` and `evolve` resolve `--policy` by this one rule | shipped | 0.5.0 | `cli/run-d49-policy.test.ts`, `cli/assets.test.ts` |
| Memory graph (Kùzu): writes with bound parameters; each query result is closed as it is read | shipped | 0.1.0 (result lifetime 0.3.0) | `memory-graph/graph-parameters.test.ts`, `memory-graph/native-lifetime.test.ts`, `cli/native-lifecycle.test.ts` |
| Planner recall of past failures ([D-16](docs/DECISIONS.md), [D-37](docs/DECISIONS.md)): a failed node is recorded as a Task joined to its Failure, the Task carrying the title of the run it was planned for; the planner recalls up to five, most recent first, whose Task text contains the first three words of the new title, ignoring case | shipped | 0.3.0 | `memory-graph/failure-recall.test.ts`, `dag-runner/failure-recorder.test.ts`, `planning-agent/failure-recall.test.ts`, `cli/failure-recall.test.ts`, `cli/run-failure.test.ts` |
| Harness configs: content-addressed, with a tamper-checking store; the attestation's `configSource` names the stored harness file and its sha | shipped | 0.1.0 | `harness-config/harness-config.test.ts`, `harness-config/resolveHarnessRef.test.ts`, `cli/run-acceptance.test.ts`; the sha MAF also stamps on the Run and tool-invocation nodes has no test |
| A run's recorded harness is the content it dispatched: without `--harness`, `legacy-default` is minted again from `roles.yaml` and each prompt file's text on every run, unless the operator pointed CURRENT elsewhere | shipped | 0.3.0 | `harness-config/resolveHarnessRef.test.ts`, `harness-config/harness-config.test.ts`, `harness-config/store-concurrency.test.ts`, `roles/harness-identity.test.ts`, `cli/run-harness.test.ts`, `cli/harness-set-current.test.ts` |
| LCM context engine | experimental | 0.6.0 | — no tests; summaries are a placeholder |
| Evaluation harness (`maf goldens run\|compare`) with a live adapter | shipped | 0.1.0 | `eval-harness/eval-harness.test.ts`, `cli/goldens-outcome.test.ts` |
| Offline evaluation ([D-14](docs/DECISIONS.md), [D-38](docs/DECISIONS.md)): `goldens run --adapter scripted` needs no model, no key and no earlier run; a default harness and its baseline result are committed; every evaluation uses its own empty graph; `goldens compare` refuses results measured differently; `maf harness import`. A golden run scores a harness and never reads a bundle back, so the offline corpus is blind to every bundle field — `modelSurfaces` (F4), `policyInForce`, `executionTiers` — and a live run is the standing check for all three | shipped | 0.3.0 | `eval-harness/scripted-adapter.test.ts`, `eval-harness/offline-baseline.test.ts`, `eval-harness/corpus-integrity.test.ts`, `eval-harness/judge.test.ts`, `cli/goldens-offline.test.ts`, `cli/harness-import.test.ts`, `cli/eval-commands.test.ts`; e2e |
| Evolver (`maf evolve`) | experimental | 0.6.0 | `evolver/evolver.test.ts`, `cli/evolve-smoke.test.ts` |
| `maf inprocess-demo` (offline by default) | shipped | 0.1.0 | `cli/demo-fixture.test.ts`, `cli/inprocess-demo.test.ts`; e2e |
| The agent's `git.*` tools run with hooks, `core.fsmonitor` and commit signing off, ignore the host's git configuration, and act only on the run's own working tree; `fs.write`, `fs.delete` and `patch.apply` refuse any path into `.git` | shipped | 0.3.0 | `tools/git-isolation.test.ts`, `tools/git-args.test.ts`, `tools/worktree-confinement.test.ts` |
| Backends: Claude Code, Gemini, Codex (CLI); Ollama, OpenRouter (HTTP) | shipped | 0.1.0 | `adapters/claude/ClaudeAdapter.test.ts`, `adapters/codex/CodexAdapter.test.ts`, `adapters/gemini/GeminiAdapter.test.ts`, `adapters/openrouter/OpenRouterAdapter.test.ts`, `adapters/openrouter/transport.test.ts`, `adapters/ollama/OllamaAdapter.test.ts`, `adapters/ollama/transport.test.ts`, `adapters/base/ProcessSpawner.test.ts`; the CLI adapters are tested with a stand-in spawner, not the real binaries |
| Toolchain floor ([D-21](docs/DECISIONS.md)): `engines` declares Node ≥ 22, pnpm 10, a `maf` bin that runs from `PATH` on Linux and macOS; the CLI itself refuses to start below Node 22, with `maf requires Node 22 or newer (found vX)` and exit status 1, because npm only warns about `engines` | shipped | 0.4.0 (the runtime check 0.5.0) | the root `package.json` pins `packageManager: pnpm@10.34.7` with `engines` and `pnpm.onlyBuiltDependencies`; `pnpm-lock.yaml` is v9; `cli/shebang.test.ts` runs the built bin through its shebang; `cli/nodeVersion.test.ts` |
| Docker image | planned | not scheduled | — |
| Published package `@cj-coding-apps/maf` (bin `maf`), from the 0.6.0 release ([D-50](docs/DECISIONS.md)): the workspace's internal packages are bundled into one `dist/main.js` and the six runtime dependencies stay pinned in the manifest; the tarball ships the bundle, the assets it reads, the README and the licence, and nothing named `workspace:` or `@maf/*`; the installed command runs `inprocess-demo` and the offline goldens from a repository with no checkout, using the corpus the package ships | planned | 0.6.0 | `scripts/pack-check.mjs` and the CI job `package · npm pack · install · run` (the artifact is built, packed and tested on every PR; it is not published) |

## What it does

- **Per-role dispatch.** Each DAG node runs as a role with its own system prompt and tool allowlist, from the run's harness: by default the one minted from the target's `.maf/roles.yaml`, or the built-in role set when there is no such file. A role name the role set does not define is refused where the DAG is built. See [docs/ROLES.md](docs/ROLES.md).
- **Two execution tiers, governed by default for writers.** `in-process` runs a multi-turn loop in which MAF executes every tool call itself; `cli` hands the backend one prompt and reads back one result while the backend runs its own tools. A role that holds a write tool runs in-process unless its `execution` says `cli`; a read-only role runs on the `cli` tier unless it says `in-process`, which the three built-in readers now do ([D-01](docs/DECISIONS.md), [D-44](docs/DECISIONS.md)). Only the Claude adapter can run the in-process loop: on any other backend a writer refuses to start unless the run is given `--allow-ungoverned`. Only the in-process tier is governed by the policy engine, the approval gate, the processor pipeline and redaction; see [In-process execution](#in-process-execution--the-tool-call-protocol) and [docs/SECURITY.md](docs/SECURITY.md).
- **Typed processor pipeline** (in-process tier). Per-turn behaviour is a bundle of hook-indexed `Processor`s with contract-enforced, permitted mutations; the default bundle is `policy-audit`, `secret-redact`, `transcript` and `security-gate`. See `@maf/processors`.
- **Policy engine** (in-process tier). Rules in `.maf/policy.yaml` match on tool id, role, minimatch path globs (dotfiles included) and Cypher memory-pattern queries. Verdicts are Allow, Deny, Escalate and Indeterminate. Allow runs the tool; Escalate runs it only if a person at the terminal approves that one call, and a run with no terminal refuses it; Deny and Indeterminate refuse it. Every path a tool declares is confined to the project root before any rule is read. See [docs/POLICY.md](docs/POLICY.md).
- **Worktree isolation.** A run starts from the target's HEAD in its own worktree, `.maf/worktrees/<runId>`, on a new branch `maf/<runId>`, and every agent, the planner and the security reviewer work there ([D-03](docs/DECISIONS.md)). On success MAF commits what the run left uncommitted to that branch and prints `git merge maf/<runId>`; it merges nothing. A failed run keeps its worktree for inspection. A branch that commits MAF's own runtime state is offered no merge, and the run exits non-zero ([D-35](docs/DECISIONS.md)). `--no-worktree`, or `worktree: false` in `.maf/config.yaml`, runs in the target directory itself after a warning.
- **Security gate.** Every role that holds a write tool has its change reviewed by a security agent, as one diff of the whole repository — even when `-d` names a subdirectory — against the commit the node started from. Only this run's runtime state under `.maf/` (transcripts, bundles, the memory graph and the like) is left out; MAF's configuration there (`policy.yaml`, `roles.yaml`, `config.yaml`, `prompts/`) is reviewed like any other file ([D-29](docs/DECISIONS.md)). A diff longer than the gate's cap (60,000 characters by default) fails the node instead of being cut short. A critical or high finding fails the node whatever the reviewer's own `passed` field says; a reviewer that times out is a transport failure, retried, not a refusal. The review runs once per attempt whatever the node's outcome: on success, on failure, on an exhausted budget, and when the backend or the in-process loop throws, in which case a refusal outranks the error ([D-31](docs/DECISIONS.md)). In-process it runs at `task_end` through the `security-gate` processor, or right after the loop when a harness's processor bundle leaves that processor out.
- **A role that holds no write tool never runs unwatched either** (F7). A node that holds no write tool — on either tier — brackets its turn with two working-tree snapshots and diffs those; a writer is still diffed against the commit it started from. So a reader's turn is checked too: a non-writer whose *own* turn changed the tree fails with `unexpected_change`, the mirror of `no_change`, and the change is recorded as a subject of the run's signed statement, so a change MAF did not expect is in the evidence even though the node fails. The guard sees exactly what the security gate's diff sees and no more: a path the repository's `.gitignore` already ignores, and this run's own runtime state under `.maf/`, are outside both. The bracket is what makes it the reader's own change: a writer's uncommitted work in the shared worktree, or your own dirty checkout under `--no-worktree`, sits in both snapshots and is not blamed on the reader. MAF does **not** revert the change: in the default run, and under `--no-worktree`, that working tree is your own checkout, so the message names the files and prints the `git -C <dir> diff` and `git -C <dir> checkout -- <path>` lines instead. On the `claude` backend a `cli`-tier reader is spawned with only the reading tools (`--tools Read,Glob,Grep`); `codex` and `gemini` have no known equivalent and keep their own tools, so for them this diff guard is the only defence. Which tier each node ran on — and whether a role fell back from the governed loop — is in the bundle (`executionTiers`, [D-06](docs/DECISIONS.md)).
- **Human review gate.** With `--review`, or under a harness that sets `reviewGate: { required: true }`, each writer change the security gate passed is shown to a reviewer at the terminal, who types `approve` or `deny`. The node waits for the answer, up to 10 minutes. A required review fails the node on anything but an approval and, when no one can be asked, refuses every writer change; an advisory one (`--review` alone) records the decision and lets the node complete. Either way the decision is in the attestation ([D-34](docs/DECISIONS.md)). See [docs/SECURITY.md](docs/SECURITY.md#the-human-review-gate).
- **Secret redaction** (in-process tier). Eight credential formats (API/LLM/cloud keys, tokens, private keys) are stripped from tool results before the model sees them, and from tool inputs and results before they reach the memory graph or the attestation bundle. It is format-based and shallow: only top-level string values of a tool's input are scrubbed, and the bundle is byte-faithful apart from the matched substrings.
- **Attestation.** At the end of a run MAF writes an in-toto Statement: its subjects are the diffs the run's writer nodes left, one per node, and its predicate records the adapter, the model, the harness, every in-process tool call (refused calls included, with the verdict and, where a rule decided, its id), every approval and review decision, the security findings, the run outcome, and `keySource` (`env` or `dev`). The signature is HMAC-SHA256 over the statement's RFC 8785 canonical bytes, so a re-serialized copy still verifies and a changed byte does not; `maf attest verify <bundle>` checks one ([D-36](docs/DECISIONS.md)).
- **Memory graph.** A Kùzu database at `.maf/memory.kuzu` records each run, every node that failed (a Task joined to its Failure, which the planner recalls when a similar title is planned again), every security refusal, and every in-process tool call.
- **Harness configs.** The role set — each prompt file's text included — the processor bundle, the review requirement and the planner knobs form one serializable, content-hashed object under `.maf/harnesses/`; a run dispatches from it and its attestation names it. `maf goldens` scores a harness against a golden corpus, with a live model or offline with `--adapter scripted`.

## Quickstart

### Build from source

A fresh clone has no `dist/`, which is not committed, so build before running anything:

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
```

- **Node 22.** It is the version CI builds and tests on, and the package refuses anything older.
- **git.** The target directory of `maf run` must be in a git repository with at least one commit
  (unless you pass `--no-worktree`): a run's worktree starts from HEAD, and a writer role's change
  is reviewed as a diff against the commit its node started from.
- **npm.** `test.run`, and so the demo, runs `npm test` in a project where it recognises no other
  test runner.
- **Native modules.** The package depends on six libraries, two of which carry native code: `kuzu`
  (0.7.1) and `better-sqlite3` (11.x). The install needs a prebuilt binary for your platform and Node
  version; where none exists, installing them means compiling from source, which needs a C++
  toolchain.
- **For `--adapter claude`:** a Claude Code CLI on your `PATH` whose `claude --help` lists
  `--tools`, `--strict-mcp-config` and `--mcp-config`. MAF passes all three; see
  [Before `maf run`](#before-maf-run). MAF runs the first `claude` on `PATH`, so a Node version
  manager's bin directory can put an older CLI ahead of the current one; if a run stops at planning
  with `unknown option '--tools'`, check `which -a claude`.
- No browser and no `playwright` install is needed.

In a checkout, every `maf <command>` elsewhere in this README is `node packages/cli/dist/main.js <command>`, because nothing puts `packages/cli`'s bin on your `PATH`:

```bash
# watch the in-process gated loop run end-to-end against a throwaway fixture.
# Deterministic and offline by default; --live drives the real `claude` binary.
node packages/cli/dist/main.js inprocess-demo
node packages/cli/dist/main.js inprocess-demo --live
#    The demo prints the path of the bundle it signed ("attn signed bundle: …"); check it:
node packages/cli/dist/main.js attest verify <that path>

#    Score the committed default harness on the golden corpus offline (no model, no key),
#    then compare the result with the committed baseline. The second argument is the result to
#    compare (a harness sha under .maf/goldens/results, or a result file); `baseline.json`'s own
#    `harnessSha` is a no-regression check, and any other harness sha is a candidate.
node packages/cli/dist/main.js goldens run --adapter scripted --corpus tests/goldens
node packages/cli/dist/main.js goldens compare tests/goldens/baseline.json <harness-sha>

#    Run an agent against a target git repository (needs the chosen backend).
#    The run works in its own worktree and branch, and on success prints the merge command.
export MAF_SIGNING_KEY='<a secret you keep>'   # see "Before maf run" below
node packages/cli/dist/main.js run "add a hello function" -d /path/to/repo --adapter claude
#    [maf] worktree: /path/to/repo/.maf/worktrees/<runId> (branch maf/<runId>, from <commit>)
#    …
#    [maf] the run's work is on maf/<runId> (worktree …). To take it: git merge maf/<runId>
#    To run in /path/to/repo itself, on its checked-out branch, add --no-worktree.
```

`pnpm pack:package` builds the publishable tarball's staging directory, and `pnpm check:package` packs it, installs it into an empty prefix and runs the commands above from the installed package — that check is the CI job `package · npm pack · install · run`.

### Install from npm (from 0.6.0)

The package is built and tested on every PR, but not yet published; the first npm release is 0.6.0, when the LCM context engine and the evolver ship ([D-50](docs/DECISIONS.md)).

```bash
npm install -g @cj-coding-apps/maf
maf --version
```

### Use it in your repository

```bash
cd /path/to/your/repo             # a git repository with at least one commit
maf init                          # writes .maf/: policy, roles, config, prompts and the default harness

export MAF_SIGNING_KEY="$(openssl rand -hex 32)"
maf run "add a hello function"    # works in .maf/worktrees/<runId> on branch maf/<runId>
# [maf] worktree: /path/to/your/repo/.maf/worktrees/<runId> (branch maf/<runId>, from <commit>)
# …
# [maf] the run's work is on maf/<runId> (worktree …). To take it: git merge maf/<runId>

maf attest verify .maf/attestations/<runId>.bundle.json
```

`maf init` writes the shipped `.maf/` — policy, roles, config, prompts and the default harness — and
prints the next command. Only the policy is also what `run` falls back to when the file is absent;
with no `.maf/roles.yaml`, `run` uses its built-in role set, which is **not** the shipped one, and
prints one line saying so (the shipped `roles.yaml` gives `tester` `fs.write`, the built-in set does
not, and the prompts differ). It refuses a directory that is not a committed git repository, because
a run has no HEAD to start from there, and it refuses a symlink anywhere it would write rather than
writing through it; running it again keeps every file you have edited, and `--force` replaces them.
Nothing else is required: with no `.maf/policy.yaml` and no `--policy`,
`run` applies the built-in policy and says so once
([D-49](docs/DECISIONS.md)); `--policy none` runs without rules. The adapter defaults to `claude`.

### Before `maf run`

- **Set `MAF_SIGNING_KEY`** to a secret of your own, or the bundle is evidence of nothing. Without it, `run` prints one warning line to stderr, signs with the public development key, and the bundle records `keySource: "dev"`. The key is not hidden from the agent; see [docs/SECURITY.md](docs/SECURITY.md).
- **Pick a backend.** `--adapter claude|gemini|codex` needs that CLI on your `PATH`; without the flag, the run takes `adapter` from `.maf/config.yaml`, else `claude`. `--adapter openrouter` needs `OPENROUTER_API_KEY`; `--adapter ollama` needs an Ollama server (`OLLAMA_BASE_URL`, default `http://localhost:11434`). Neither HTTP adapter has a default model: set `OPENROUTER_MODEL` or `OLLAMA_MODEL`, or pass `--model`, or the first model call is refused before it is sent.
- **Writers run governed, which only `claude` can do.** A role that holds a write tool runs in MAF's in-process loop ([D-01](docs/DECISIONS.md)). On `gemini`, `codex`, `ollama` or `openrouter`, which cannot run that loop, `run` refuses before planning, naming each writer role, unless you pass `--allow-ungoverned`. That flag runs those writers on the `cli` tier, outside MAF's policy, approval gate, redaction, attested tool calls and processor hooks, and prints an `UNGOVERNED` banner once. An HTTP backend has no file tools, so a writer there cannot change the tree at all, and `coder` then fails with `no_change`.
- **In-process turns spawn `claude` with nothing of its own.** Each turn runs `claude --print` with `--tools ""`, which turns its built-in tools off, and `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, which leaves it no MCP server ([D-33](docs/DECISIONS.md)): the only tools in the loop are MAF's, each call through the policy engine. Each turn's system prompt says the same thing: MAF's tool protocol opens by telling the model the host's own tools — `Read`, `Write`, `Bash` and the rest — are not available this turn and that a request for one is refused, so what the prompt claims of the backend matches what `--tools ""` did to it ([D-46](docs/DECISIONS.md); a backend that gains an in-process loop with its own tools on would make that sentence a lie). This needs a Claude Code CLI that has the `--tools` flag; check `claude --help`.
- **On the `cli` tier the backend keeps its own permissions and hooks.** That tier serves a custom read-only role (the three built-in readers ask for `in-process`, [D-44](docs/DECISIONS.md)), the planner's and the security gate's own calls, and writers under `--allow-ungoverned`. MAF hands the backend one prompt and no hook flags. Codex is invoked with `--full-auto`, its sandboxed automatic mode, on every `cli`-tier call. The planner's and the security reviewer's calls need only text, so `claude` gets `--tools ""` on them, as on an in-process turn; `gemini` and `codex` have no known flag for that and keep their tools. A `cli`-tier role that holds no write tool is different again: it is spawned with only `--tools Read,Glob,Grep`, so a read-only reviewer cannot edit the tree at all — and, since it is a reader's turn, any change the *turn itself* made would fail the node with `unexpected_change` and be recorded as a subject ([F7](docs/SECURITY.md)). `codex` and `gemini` have no known flag for the read-only set, so there the diff guard is the only defence. Otherwise the backend runs under its own configuration: `claude --print` refuses file edits unless your Claude Code permissions allow them, and MAF does nothing to turn off the hooks your Claude Code settings configure — none of which MAF's policy engine sees. MCP is different: `claude` gets the same empty, strict MCP configuration as an in-process turn, so none of your MCP servers is started for it; `gemini` gets `--allowed-mcp-server-names` naming a server no configuration defines (not checked against a live `gemini`); `codex` gets no MCP flag, so MAF does nothing to stop the servers its configuration names. A `cli`-tier `coder` that exits 0 with an answer and an unchanged tree fails with `no_change`, as an in-process one whose loop completes with an unchanged tree does; a role without `expectsChange`, such as the tester, still reports `Succeeded` with empty diff hashes, so read the bundle's subjects, not only the verdict.
- **Your working tree is left alone.** The run starts from HEAD in its own worktree and does not see uncommitted or untracked work; when there is some, it says so. The agent's file and git tools cannot reach your checkout from there; `test.run`, which runs your project's own test command, is not confined (see [docs/SECURITY.md](docs/SECURITY.md)). Commit first what the run should build on. `--no-worktree`, or `worktree: false` in `.maf/config.yaml`, runs in the target directory instead, on its checked-out branch: the run warns, the security gate and any reviewer see your uncommitted changes as the run's own, `--review` on such a tree is refused, and the coder's `git.commit` and `git.reset` (which can be `--hard`) act on your branch.
- **Someone may be asked.** When stdin is a terminal, an `Escalate` verdict prompts there for that one call, and `--review` prompts for each writer change; both write to stderr. With stdin not a terminal, or `MAF_HEADLESS=1`, nobody is asked: an escalated call is refused and recorded under `.maf/approvals/pending/`, `--review` prints one line and runs without a review, and a harness that requires review has every writer change refused.

`run` reads `.maf/config.yaml`, `.maf/policy.yaml` and `.maf/roles.yaml` from the target directory — not from the run's worktree, so uncommitted edits to them count — and creates `.maf/` if it is missing. `--policy` and `--roles` take other paths, resolved against the target directory. `run`, `goldens` and `evolve` resolve `--policy` through one function, so the three cannot disagree about what governs them ([D-49](docs/DECISIONS.md)).

- **Settings come from the command line, then `.maf/config.yaml`, then the built-in defaults**, decided key by key. The flags are `-a/--adapter`, `-m/--model` and `--no-worktree`; `lcm`, `dag` (concurrency and retry) and `timeouts` (the planner's call, the security review) come from the file only. The [shipped `.maf/config.yaml`](.maf/config.yaml) states every key at its default. A missing file prints one line and the defaults apply; a file that is not YAML, holds a key the schema does not know, or a value out of range stops the run, naming each problem and its line.
- **Upgrading from 0.2.1:** that release did not read `.maf/config.yaml`, and the file it shipped is refused now, with `unknown key "version"` and `unknown key "defaults"`. Delete `version`; move every key out of `defaults` to the top level and delete `defaults`; delete `circuit`, which nothing on the run path reads; then check the values you keep, which take effect for the first time. Or delete the file and run on the defaults.
- With no `--policy` **flag** and no `.maf/policy.yaml` in the target, `run` applies the policy shipped in the package — the repository's own `.maf/policy.yaml`, byte for byte ([D-49](docs/DECISIONS.md)) — and prints one line naming the built-in policy and its rule count. The bundle records `policyInForce.sourceKind: "built-in"`, no `source` path, and the digest of the shipped text. `--policy none` is the explicit opt-out: no rules apply, and the bundle records `policyInForce.sourceKind: "none"` with no path and no digest. Path confinement applies either way. **A typed path is a statement about which file you mean.** `--policy <path>` that names no file stops the run with `policy file <path> not found; pass --policy none to run without rules` — spelling out `.maf/policy.yaml` by hand is such a path, so its absence stops the run too; only a flag that was never typed falls back to the built-in policy. A policy file the run was pointed at — the default path when it exists, or any typed `--policy <path>` — that is not valid YAML, or fails validation, stops the run with the error: a broken file never falls back either. A file that loads records `policyInForce.source` (its absolute path), `sourceKind: "file"` and `sha256` (the bytes read); `source` stays the path it was in 0.4.0, and `sourceKind` is the additive field.
- Policy files are YAML, and JSON parses too. Quote every glob: YAML reads a bare value starting with `*` as an alias and one starting with `{` as a mapping.
- `roles.yaml` is YAML; the JSON form, `#` comment lines included, loads unchanged. If no file exists at the path, the built-in role set applies — **not** the `roles.yaml` the package ships, which `maf init` writes; the built-in `tester` holds no `fs.write` and the prompts differ, so a run without the file prints `[maf] roles: no .maf/roles.yaml — using the built-in role set (maf init writes the shipped one)`. One that exists but does not load stops the run, naming the file and, for a YAML error, the line. A `<<` merge key is refused ([D-40](docs/DECISIONS.md)), and so is an empty `systemPrompt`.

**Which harness runs.** `run` prints `[maf] harness: <id> (<sha>) [<source>]`. The source is `legacy` for a harness minted from the roles file as it is now (`legacy-default`, re-minted whenever `roles.yaml` or a prompt file it names changes), `current` for the harness CURRENT names when an operator pointed it there, and `flag` for `--harness <id|sha|prefix>`. A typed `--roles` without `--harness` means that file, even when CURRENT is set. `maf harness set-current <ref>` points CURRENT at a stored harness, and the next plain run uses it; it refuses an older `legacy-default` snapshot, which `--harness <sha>` runs instead, and `set-current legacy-default` hands plain runs back to the roles file. **Upgrading from 0.2.x:** a CURRENT that names a `legacy-default` snapshot simply tracks the roles file again; a CURRENT an operator pointed at another harness from before 0.3.0 — one that names prompt files without carrying their text — stops every plain run, with an error naming `maf harness set-current legacy-default` as the remedy. The committed default harness in `.maf/harnesses/` is what `goldens` evaluates on a fresh clone; an installed package that has no committed default falls back to the `default-<sha>.json` it ships in `assets/harnesses`, so `maf init && maf goldens run --adapter scripted` works with nothing copied in. `run` uses the committed default only when named (`--harness default`), importing it into the store first.

Other commands: `maf harness list|show|set-current|import`, `maf goldens run|compare` (score harnesses against the golden corpus, with a live adapter or offline with `--adapter scripted`; `compare` exits 1 on a regression and 2 when the results cannot be compared), `maf attest verify <bundle>`, `maf evolve` (experimental, see Status), `maf adapters` (availability), `maf merge-runs`.

## Architecture at a glance

```
        maf run "task"
               │
               ▼
┌──────────────────────────────┐
│  harness · WorktreeManager   │  dispatch from one harness; work in .maf/worktrees/<runId>
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  RetrievalAugmentedPlanner   │  the model writes the plan; past failures recalled; role names checked
└──────────────┬───────────────┘
               │ DAG with one agentRole per node
               ▼
┌──────────────────────────────┐
│          DagRunner           │  writer lock, transport-only retry, failures recorded
└──────────────┬───────────────┘
               │ executor(node)
               ▼
┌───────────────────────────────────────────────────────┐
│                    RoleDispatcher                     │
│  RoleRegistry · RoleToolRegistry · GraphAwareInjector │
└──────┬─────────────────────────────┬──────────────────┘
       │ cli tier                    │ in-process tier
       │ (readers; writers only      │ (writers, by default)
       │  with --allow-ungoverned)   ▼
       ▼                ┌───────────────────────────────┐
┌──────────────┐        │      InProcessAgentLoop       │
│  CliAdapter  │        │ processors · executeToolGated │
│   invoke()   │        │       → ApprovalGate          │
└──────┬───────┘        └───────────────┬───────────────┘
       │ writer roles                   │ writer roles, at task_end
       ▼                                ▼
     ┌────────────────────────────────────────┐
     │  SecurityReviewGate  →  ReviewGate     │
     │                     (when asked for)   │
     └───────────────────┬────────────────────┘
                         ▼
     ┌────────────────────────────────────────┐
     │  Attestor → signed in-toto Statement   │
     └───────────────────┬────────────────────┘
                         ▼
               git merge maf/<runId>  (printed, not run)
```

### Packages

| Package | Purpose |
|---|---|
| `@maf/types`            | Branded IDs, shared interfaces (DagNode, ToolContext, PolicyPredicate, AttestationBundle, etc.), the error classes the scheduler classifies by (`TransportError`, `VerdictError`, `NodeFailure`, `GateRefused`, `ReviewRefused`), `resolveInside` path confinement, and `canonicalJson`, which harness shas are computed with. The one package that is not types-only: `paths.ts` reads the filesystem at run time, deliberately, because the tools and the policy engine both need the primitive and neither may depend on the other |
| `@maf/blackboard`       | In-process key/value store wired into LCM via `BlackboardToLcmAdapter` |
| `@maf/lcm` / `@maf/lcm-adapter` | Experimental: a SQLite transcript store with compaction and keyword recall; the summaries `maf run` gives it are a placeholder (the first 200 characters of each message) |
| `@maf/memory-graph`     | Kùzu-backed graph with bound query parameters (Run, Task, Failure, ToolInvocation, GoldenResult, EvolutionRound nodes); `recallFailures`, the one failure-recall query |
| `@maf/transcript`       | Append-only JSONL transcript with LCM flush triggers |
| `@maf/policy-engine`    | `PolicyLoader` (validating YAML loader, and the `parseYamlDocument` the config and roles loaders share) and `PolicyEngine`: path-glob, role and Cypher-memory predicates; Allow / Deny / Escalate / Indeterminate; `inForce()`, the record of the rules loaded and how the calls fell, which the bundle carries (F6) |
| `@maf/approval-gate`    | The approval gate for `Escalate` verdicts: a terminal provider, a headless provider that refuses and writes a pending record, request hashing, and the recorder that attests each decision |
| `@maf/prompt-injector`  | `GraphAwareInjector` assembles role-aware system prompt prefixes |
| `@maf/tools`            | Built-in tool plugins: fs.*, grep, git.* (hooks and host git configuration off), patch.apply, test.run |
| `@maf/tool-loop`        | `executeToolGated`, the one gated executor (the input checked against the tool's schema; policy; an `Escalate` goes to the approval gate; a refusal is attested and thrown; otherwise execute → redact → attest, a tool that throws answered as a failed call), and `InProcessAgentLoop`, the multi-turn in-process agent loop. `ToolLoop`, `PatchTestCycle` and `CircuitBreaker` are also here and are not used by `maf run` |
| `@maf/processors`       | Hook-indexed typed `Processor` pipeline + contract validator; default bundle (policy-audit, secret-redact, transcript, security-gate); `redaction.ts` |
| `@maf/harness-config`   | Content-addressed `HarnessConfig` (role set + processor bundle + review requirement + planner knobs), canonical sha, tamper-checking `HarnessStore` with atomic writes, and `resolveHarnessRef`, which decides the harness a run dispatches |
| `@maf/eval-harness`     | Golden corpus (required provenance, corpus sha, protected files), verifiers (test-script / security-gate / diff-match / llm-judge), the judge prompt and parser, `ScriptedAdapter` (the deterministic offline model), `GoldenRunner`, pure `seesawDecision` |
| `@maf/evolver`          | Experimental: an AEGIS-lite loop over a bounded `HarnessEdit` surface, with instruction screening and a deterministic gate (never in the serving path) |
| `@maf/dag-runner`       | Concurrency-limited DAG executor: one writer at a time, retry for transport failures only, a failure recorder called once per failed node. Its `reviewGateNodeIds` setting is not acted on |
| `@maf/planning-agent`   | `RetrievalAugmentedPlanner` (recalls past failures into its prompt), `DagSynthesizer`, and `FailurePatternDetector`, which reads failures through the same query |
| `@maf/git-ops`          | **SecurityReviewGate**, `snapshotDiff`, `runIsolatedGit`, `WorktreeManager` (a run's worktree and branch, and its hand-over) and `ReviewGate` (the human review gate); also `BranchIsolator` and `RollbackManager`, which `maf run` does not use |
| `@maf/attestation`      | The run's in-toto Statement with a SLSA-style provenance predicate, HMAC-signed over RFC 8785 bytes (`jcs.ts`) with its `keySource` inside; `Attestor.verify`, `Attestor.inspect` and `Attestor.report`, which also verify 0.2.x bundles as `legacy`; the evidence fields a run appends — `securityFindings`, the policy in force (`recordPolicyInForce`, F6) and each role call's model-facing surface (`recordModelSurface`, F4; both tiers since WP-3.0c); `componentId`/`mafVersion` |
| `@maf/roles`            | `RoleRegistry`, `RoleToolRegistry`, `RoleDispatcher` (tier resolution, cli/in-process dispatch, node verdicts, post-task security and review gates), `effectiveTier`, `isWriterRole`, `isWriterForLock`, default role set, the harness ↔ role-set bridge |
| `@maf/adapters/*`       | Claude Code, Gemini and Codex CLI bindings; Ollama and OpenRouter HTTP adapters (Claude and Codex implement the `TurnAdapter` turn protocol; only Claude reports the `inProcessLoop` capability) |
| `@maf/cli`              | The `maf` command (`run`, `harness`, `goldens`, `evolve`, `inprocess-demo`, `attest`, `adapters`, `merge-runs`), `.maf/config.yaml` loading, and the terminal reviewer |

## In-process execution & the tool-call protocol

A role's tier comes from its `execution` field. Left unset, a role that holds a write tool (`fs.write`, `fs.delete`, `patch.apply`, `git.commit`, `git.reset`, `git.add`, or `test.run`, which runs the project's own code) runs **`in-process`**, and any other role runs on the **`cli`** tier, where MAF hands the backend CLI one prompt and reads back one opaque result. On the `cli` tier the backend runs its own tools and the role's tool allowlist is not passed to it, so MAF's policy engine and processors see no individual tool call.

The five built-in roles (`packages/roles/src/defaults.ts`; they apply only when the target has no roles file):

| Role       | Writer? | Execution    | Allowed tools                                                                                                                           |
|------------|---------|--------------|----------------------------------------------------------------------------------------------------------------------------------------|
| `coder`    | yes     | `in-process` | `fs.read`, `fs.write`, `fs.delete`, `fs.stat`, `fs.list`, `grep`, `git.{status,diff,add,commit,log,reset}`, `patch.apply`, `test.run`   |
| `tester`   | yes     | `in-process` | `fs.read`, `fs.list`, `fs.stat`, `grep`, `test.run`, `patch.apply`                                                                     |
| `security` | no      | `in-process` | `fs.read`, `fs.list`, `fs.stat`, `grep`, `git.diff`, `git.log`                                                                          |
| `reviewer` | no      | `in-process` | `fs.read`, `grep`, `git.diff`, `git.log`                                                                                                |
| `analyst`  | no      | `in-process` | `fs.read`, `fs.list`, `fs.stat`, `grep`, `git.status`, `git.diff`, `git.log`                                                           |

The three readers carry `execution: 'in-process'` ([D-44](docs/DECISIONS.md)): on the `cli` tier a read-only role is handed the backend's own file tools, so a review or an audit that only reads the tree is still a change MAF did not gate at the moment it happened. A **custom** read-only role is unchanged — it still runs on the `cli` tier unless it sets `execution: 'in-process'` ([D-01](docs/DECISIONS.md)). `analyst` is the fifth built-in ([D-43](docs/DECISIONS.md)): a read-only role that answers a question about the code and makes no change, so a plan that asks for an investigation has somewhere to route it that is neither a writer nor a diff-reviewer.

On the in-process tier `InProcessAgentLoop` runs a real multi-turn loop where **MAF drives every tool call**. A role only takes this path when the adapter both implements `TurnAdapter.sendTurn` **and** reports `capabilities().inProcessLoop === true` (among the backends, only Claude; Codex ships `sendTurn` but keeps the capability off, and no Codex flag is known to turn its own tools off as [D-33](docs/DECISIONS.md) requires; the offline `scripted` adapter that the demo and `goldens` use has both). Otherwise a read-only role falls back to `cli`, and the fallback is noted in the run's transcript, while a writer refuses to start unless the run allows ungoverned writers (`--allow-ungoverned`).

Per turn, the loop:

1. Sends the conversation plus a **tool catalog advertised by tool id**, each entry with its input schema (`AVAILABLE TOOLS: - fs.write [write]: … — input: {"path": string (required), "content": string (required), "createDirs": boolean}`, then a line saying what each field means) to the model. The model requests a tool by emitting one fenced block:
   ````
   ```tool_call
   {"toolName":"fs.write","input":{"path":"sum.js","content":"…"}}
   ```
   ````
2. Runs the 8 processor hooks (`task_start`, `step_start`, `before_model`, `after_model`, `before_tool`, `after_tool`, `step_end`, `task_end`) with contract-enforced mutations: a processor that writes a read-only field, in place or on a copy, throws `ContractViolation`.
3. Answers a call to a tool outside the role's allowlist with an error, before policy. Every other call goes through `executeToolGated`, which first checks the input against the tool's schema: a call with a required field missing, a field of the wrong type or a field the tool does not take is answered with an error naming the input the tool expects, and not executed — no paths declared, no policy asked; it is recorded as `Indeterminate` under rule id `builtin:input-schema`, and the model can send it again. Then `policy.evaluate`; an `Escalate` verdict is then put to the run's approval gate, and an approval runs the call once; any other verdict but Allow, or an `Escalate` not approved, is attested as a refusal and the model is told why; an allowed call runs `tool.execute → redact secrets → attestor.record`, and a tool that throws while running (`fs.read` of a file that is not there) is answered the same way, as a failed call — `fs.read failed: ENOENT: …` — rather than ending the node. Policy always runs **after** any processor edits; a processor can narrow a tool input but never widen an allowlist.
4. Enforces `role.tokenBudget` (real usage if the adapter reports it, else a conservative estimate) and `role.maxToolIterations`. A loop that hits either ends `budget_exhausted`, which fails the node unless the node sets `allowPartial: true`. Only a DAG built in code can set `allowPartial`; DAG specs and the planner cannot (see Status).
5. Runs the security gate for a writer role on **any** outcome the loop returns (completed / budget-exhausted / failed), so a partial diff is never left unreviewed: at `task_end` through the `security-gate` processor in the default bundle, or, for a harness whose processor bundle leaves it out, right after the loop. If the loop throws instead — a turn that timed out, a backend that never started — the dispatcher still fires `task_end`, and runs the same review before the error propagates. The review runs once per attempt whichever of these reaches it first.

A turn whose backend times out, cannot start, or exits non-zero without writing anything throws the spawner's `TransportError`, so the node may be retried; a turn that exits non-zero after writing output throws an `Error` naming the exit code, with a masked stderr tail, and is not retried. Neither is read as an answer.

**Malformed tool-call repair (bounded).** If the model emits a `tool_call` fence that isn't valid JSON or lacks a string `toolName`, and no valid call parsed, the loop does not silently drop it. It appends the exact parser error and the required format to the conversation and retries, up to **`maxToolCallRepairs` (default 3)**. After the limit the turn fails loudly (`outcome: 'failed'`, and the node fails) rather than looping forever.

See it run end-to-end with `maf inprocess-demo` (deterministic scripted model) or `maf inprocess-demo --live` (real `claude`): it fixes a failing test through gated `fs.read`/`fs.write`/`test.run` calls, has an escalated `fs.delete` refused — the demo always runs headless, so nobody is asked and the refusal is recorded under the fixture's `.maf/approvals/pending/` and in the bundle's approvals — redacts a fake key in a read result, and writes a signed in-toto attestation. The demo works in its fixture directly, without a worktree.

## Configuration

Configuration lives in a `.maf/` directory inside the target repo, which `run` creates if it is missing. `run` reads it from the target directory, not from the run's worktree.

| File | Purpose |
|---|---|
| `.maf/config.yaml`  | Run settings: `adapter`, `model`, `worktree`, `lcm`, `dag`, `timeouts`. A flag outranks the file, which outranks the built-in default. Missing: one line, the defaults. Present but invalid, or holding an unknown key: the run stops |
| `.maf/policy.yaml`  | Tool/role/path rules (YAML; JSON parses too). Missing: one warning, no rules. Present but invalid: the run stops |
| `.maf/roles.yaml`   | Role definitions: prompt source, allowed tools, optional execution tier, `expectsChange`, model and limits. YAML; the JSON form loads too. Missing: the built-in roles. Present but not loadable: the run stops |
| `.maf/prompts/*.md` | Role-specific system prompts (referenced by `roles.yaml` via `promptFile`); their text is read when the run starts and carried in the harness |
| `.maf/harnesses/`   | Stored harnesses (`<sha>.yaml`, `index.json`, `CURRENT`) and, in this repository, the committed `default-<sha>.json` |

See [docs/ROLES.md](docs/ROLES.md) for the role system, [docs/POLICY.md](docs/POLICY.md) for the policy predicate reference and the approval gate, and [docs/SECURITY.md](docs/SECURITY.md) for what the security gate reads — including what it does not — and for the review gate and worktrees.

## Run output

A run produces:

1. **A worktree and a branch**, `.maf/worktrees/<runId>` on `maf/<runId>`, unless isolation is off. MAF never deletes either: remove a worktree with `git worktree remove` and its branch with `git branch -D` once you are done with them. `.maf/worktrees/` holds a `.gitignore` of its own, so it does not show in your `git status`.
2. **Transcripts** at `.maf/transcripts/<runId>.jsonl`: every user/assistant turn, tagged with `agentRole`. They are not scrubbed as a whole: what the backend or the model wrote is recorded as written.
3. **Memory graph** at `.maf/memory.kuzu`, persistent across runs: the run, each failed node as a Task joined to its Failure, each security refusal, and the in-process tool invocations, which are stamped with the producing `harness_sha`.
4. **Harness** at `.maf/harnesses/<sha>.yaml` (+ `index.json`, `CURRENT`): the content-addressed config the run dispatched from. Without `--harness` or an operator-set CURRENT, that is `legacy-default`, minted from `roles.yaml` and the prompt files as they are now; an unchanged role set reuses the stored file.
5. **Pending approvals** at `.maf/approvals/pending/<id>.json`, one per escalated call refused because nobody could be asked: the request, its hash, a timestamp and why. A record, not a queue.
6. **Attestation bundle** at `.maf/attestations/<runId>.bundle.json`: an in-toto Statement, HMAC-SHA256 over its RFC 8785 bytes, keyed by `MAF_SIGNING_KEY`. With that unset, the run warns once on stderr, signs with the public development key, and the bundle says `keySource: "dev"`; `run` prints the `keySource` beside the signature. Tool inputs and results are byte-faithful except redacted credential substrings. Check one with `maf attest verify <bundle>`: it prints `valid`, the `keySource` it checked against, the number of subjects and, for a 0.2.x bundle, `legacy: true`, and exits 1 with the reason when the bundle does not verify. From code, `Attestor.verify(bundle, { secret })` returns `true` only when the signature matches that key and the bundle's `keySource` names it, and `Attestor.inspect(bundle, { secret })` returns `{ valid, keySource, legacy }`. A bundle written by 0.2.x is MAF's own JSON, signed over `JSON.stringify`: it still verifies against the key you supply and is reported `legacy`.

### What a bundle says about the model and the policy

Three fields are a run's evidence for what the model was shown and what governed it. All sit inside the signed predicate, so none can be stripped without breaking the signature, and each is **omitted**, not written empty, when its evidence was not recorded: a reader can tell "not recorded" from "recorded as nothing", and a bundle written by an earlier release that carries none of them still parses and verifies. The rest of a run's evidence sits beside them in the same predicate: the `outcome`, which names each failed node's failure as `{kind, ruleId?, toolId?}` ([D-46](docs/DECISIONS.md)), and `attributedChanges`, one entry per change a reader's turn showed that the rule charged to a concurrent writer rather than to the reader ([D-45](docs/DECISIONS.md)).

- **`modelSurfaces`** (F4, D-45) — one entry per role call MAF made, in call order: `systemPromptSha256`, the digest of the exact system-prompt bytes the backend was handed; `promptSha256` and `outputSha256`, the digests of the prompt and of what came back; `toolCatalog`, the tool list serialized as the model was shown it; and `argv`, the backend's command line with each payload positional — the `claude` `--system-prompt` value and the prompt after the `--`, `gemini`'s `--system-instruction` value and its joined `--prompt=`, and a `cli`-tier call's prompt — replaced by its byte length and its own sha256. The flags stay verbatim, including the empty `--tools ''`; eliding the payloads keeps a turn-sized prompt out of every bundle while the digests still answer *what text*. Each entry carries a `tier` of `in-process` or `cli` (D-45, WP-3.0c), so a `cli`-tier *role* call through `claude`, `codex` or `gemini` is recorded too — before 0.4.0 only a governed in-process step had a surface. A `cli`-tier entry also carries `nativeTools` (`full`, `read-only` or `none`), the posture MAF **asked** of the backend's own tools rather than what those tools then did. A `cli`-tier turn hands the backend one opaque prompt for which MAF composes no `toolCatalog`, so that field is the empty string: `''` on a `cli`-tier entry means **MAF composed no catalogue**, not that the backend had no tools — `nativeTools` says what the backend had. Two `cli`-tier calls are still outside this record — the planner's and the security reviewer's, which MAF spawns itself rather than through a role node. The entry is whatever the adapter reports, so a role routed to `ollama` or `openrouter`, which spawn no process, records nothing, and a step whose first call was malformed and retried contributes one entry per attempt, sharing that step's number.
- **`policyInForce`** (F6, D-49) — the policy the run ran under: `source`, which is `"file"` for a policy file, `"built-in"` for the shipped default a run falls back to when no file was asked for and none exists, and `"none"` for `--policy none`; `path`, present exactly when `source` is `"file"` — the resolved `--policy` path, named whether or not a file exists there — and `sha256` of the file's bytes, absent exactly when no file was read (so a file that was asked for but is missing is `"file"` with a path and no digest, distinct from a file that was read and held zero rules); `ruleCount` and each rule as `(id, effect, matcher)`; and the counts of every verdict the engine reached — Allow, Deny, Escalate, Indeterminate. The counts are read after the last call and before the bundle is written, so a refusal is counted: it is a decision, though it never reaches a tool. This is what separates "no policy was loaded" from "a Deny rule was loaded and never fired" — with `toolCalls` and `securityFindings` alone the two runs produce identical evidence.
- **`executionTiers`** (F7) — one entry per node, in dispatch order, last-wins for a node that ran more than once: `{nodeId, role, tier, adapter, fellBackFrom?}`. `tier` is the one the node actually ran on, `cli` or `in-process`, and `fellBackFrom: "in-process"` is present exactly when the role asked for the governed loop and the adapter could not run it, so the D-06 fallback is visible per role rather than noted once in the transcript. This is the half `policyInForce` cannot show: on the `cli` tier MAF sees no individual tool call, so a rule scoped to a `cli`-tier role is in force and unreachable, and only the tier tells you which node that was. Optional, so a bundle written before 0.3.1 still parses.

**`securityFindings: []` is not "the policy was exercised".** `securityFindings` is a field of the signed predicate, written by the security gate: one entry for each time the gate reviewed a writer node's *non-empty* diff, naming the node and the review's result — and an entry can carry an empty `findings` list when the review passed clean, so a *present* entry does not mean a finding. An empty `securityFindings` therefore means the gate reviewed no diff at all: no writer node ran, every writer left the tree unchanged, every write was refused before it could reach the gate, or no security gate was wired. It is not policy evidence — a policy that denied every write leaves `securityFindings` empty, and so does a run that wrote nothing. Read `policyInForce` for the policy, and the run's `outcome` and `diffHashes` for what it changed — not the verdict alone.

## Development

```bash
pnpm build              # each package's own tsc, in dependency order
pnpm -r typecheck       # tsc --noEmit
pnpm -r test            # node:test on dist/__tests__/
```

TypeScript settings (see `tsconfig.base.json`): `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Branded ID types (RunId, TaskId, ToolId, NodeId, AgentId, EdgeId) — construct via the `make*` helpers in `@maf/types`.

Tests live in `src/__tests__/` and run from `dist/__tests__/`. Each package that has tests declares `"test": "node --test dist/__tests__/*.test.js"` in its `package.json`. Because the suite runs the **compiled** output and `tsc` never prunes it, a stale `dist/` after a branch switch can still hold a test file whose source is gone; if a run looks wrong, remove that package's `dist/` and rebuild before the suite. CI checks out clean and is not affected. Tests that open the LCM store skip where `better-sqlite3` does not load, and cannot skip in CI. CI also runs the job `e2e · demo · attestation · offline goldens`: the built demo, `maf attest verify` on its bundle, and the offline goldens compared with `tests/goldens/baseline.json` by `scripts/compare-goldens.mjs`.

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

## How this was built

Releases 0.2.1 through 0.4.0 were built by a fleet of agents working under the rules this framework enforces for the agents it runs. The record is in the repository: the plan ([docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)); the decisions each change cites ([docs/DECISIONS.md](docs/DECISIONS.md), D-01–D-47); the pull requests (#7–#45; #32, #39 and #40 were closed unmerged); and the commit messages, 168 of the 173 non-merge commits between `v0.2.0` and `v0.4.0` naming the work package, decision or finding they implement (`WP-x.y`, `D-nn`, `F<n>`).

- **One work package, one agent, one pull request**, with the exceptions the plan records (Phase 1 and Phase 2 each shipped through an integration branch, WP-2.7 was split across two stacked PRs, and WP-2.11 was split — the shebang half as #34, the toolchain floor as #36 from the maintainer's machine). Each implementer worked on its own branch with a written scope (the files it owned, the shared contracts it could not touch) and with acceptance tests stated before the code. CI ran on every PR.
- **A verifier that never saw the implementation** reviewed the work-package PRs and release branches listed in the record, from a clean checkout with the spec, the diff and the suite (the record notes the 0.3.2 hotfix as the one release without a separate pass). Its job was to break the change: mutate the code and confirm a test fails, invent the inputs the spec left out, and check every claim in the PR body and the docs against the code. Fixes went back to the same verifier until a pass found nothing above LOW; one attribution rule took five passes. The record — at least 208 findings — is in [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **A fresh-context audit of the whole branch** ran before the 0.3.0 and 0.4.0 release PRs, and each time found what no per-package verifier could see. For 0.3.0 it found a worktree escape through the agent's git tools, and a `.gitattributes` that hid a diff from the security gate. For 0.4.0 it found a release that contradicted its own plan, a built-in role that could claim work it never did, and two more places where model text reached the signed record unmasked.
- **The maintainer was the gate on `main`, with one agent merge recorded as a deviation.** Direct pushes to `main` were prohibited (BUILD_PLAN §3.2, D-27); tags, releases, repository settings and merges of PRs touching `run.ts`, `RoleDispatcher.ts`, `wiring.ts`, workflow files or versions were the maintainer's (D-26, D-27), and `pnpm-lock.yaml` beyond a mechanical bump was reserved by the plan (§3.2). Package-confined PRs could be merged by the implementing agent when CI was green and a verifier had passed. #31 touched `RoleDispatcher.ts`, was merged by the coder under the maintainer's credential, is recorded as a deviation in the plan, and produced the rule that every merge is the maintainer's — even when the instruction arrives in their own message or a runbook they hand over.
- **Live runs on a real model found what scripted tests could not.** The plan requires a live run on a real `claude` for every change to the model-facing surface — what the model is shown or how it answers — and the practice extended to the policy that governs its calls. Those runs found:
  - a flag the binary does not have;
  - a `Succeeded` with nothing changed;
  - a tool catalogue without field names;
  - a read-only role that could edit the tree while the bundle attested success;
  - a shipped `.env` rule that a real model walked around with `patch.apply`, fixed in the 0.3.2 hotfix.

  Each is in the CHANGELOG with its fix.

Agents implemented and verified. The architecture, every decision in `docs/DECISIONS.md`, and every release were the maintainer's.
