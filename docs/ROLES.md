# Roles

Every DAG node in MAF runs as a *role*. A role bundles:

1. A **system prompt** (inline or loaded from a file).
2. An **allowed tool set** — the only tools the role is allowed to call on the `in-process` tier. On the default `cli` tier the allowlist is not passed to the backend CLI, which uses its own tools.
3. Optional **model**, **timeout**, **token budget**, and **policyTag** overrides.

The planner emits `agentRole` on each node it produces. That name is checked against the role set in force **where the DAG is built** — the planner, `DagParser` and `DagSynthesizer` each refuse a name the set does not define, and the refusal lists the roles that do exist. A node carries a `RoleName`, which only a role set can produce, so an unrecognised name cannot reach the dispatcher at all. (Before this it did, and silently: an unknown name resolved to the *default* role — `coder`, a writer — so a typo or a hallucinated role name widened privilege rather than being refused.)

## Default roles

The built-in `DEFAULT_ROLE_SET` (`packages/roles/src/defaults.ts`) ships four roles. They apply when the roles file cannot be read — normally because the target has no `.maf/roles.yaml`. A roles file that exists but is not JSON, does not match the role-set shape, or names a tool that does not exist stops the run with a `RoleConfigError`.

| Role       | Writer? | Allowed tools                                                                                                                  | Use for                              |
|------------|---------|--------------------------------------------------------------------------------------------------------------------------------|--------------------------------------|
| `coder`    | yes     | `fs.read`, `fs.write`, `fs.delete`, `fs.stat`, `fs.list`, `grep`, `git.{status,diff,add,commit,log,reset}`, `patch.apply`, `test.run` | Writing & modifying production code  |
| `tester`   | yes\*   | `fs.read`, `fs.list`, `fs.stat`, `grep`, `test.run`, `patch.apply`                                                            | Writing tests only                   |
| `security` | no      | `fs.read`, `fs.list`, `fs.stat`, `grep`, `git.diff`, `git.log`                                                                 | CWE/OWASP audit, JSON-only output    |
| `reviewer` | no      | `fs.read`, `grep`, `git.diff`, `git.log`                                                                                       | Code review, approve/reject diffs    |

\* **The two tester definitions in this repository differ.** The built-in tester above (`TESTER_TOOLS` in `defaults.ts`) holds `patch.apply` and no `fs.write`: it can apply a diff but cannot create or overwrite a file. The `.maf/roles.yaml` this repository ships grants the tester `fs.write` as well. `maf run` reads `.maf/roles.yaml` from the *target* directory, so which tester a run gets depends on that directory: one with no roles file gets the built-in tester, one with a copy of this repository's file gets `fs.write`. Either way the tester is a writer (see [Writer roles](#writer-roles)), so its changes are security-reviewed. On the in-process tier the shipped policy also limits *where* it may write — `tester-write-only-tests` and `tester-no-ci-config` in `.maf/policy.yaml` — because the tool allowlist and the policy work together, and neither alone is sufficient. On the `cli` tier neither the allowlist nor the policy reaches the backend's own tools.

## `.maf/roles.yaml`

```json
{
  "version": 1,
  "defaultRole": "coder",
  "roles": [
    {
      "role": "coder",
      "description": "Writes and modifies production code.",
      "promptFile": "prompts/coder.md",
      "allowedTools": [
        "fs.read", "fs.write", "fs.delete", "fs.stat", "fs.list",
        "grep",
        "git.status", "git.diff", "git.add", "git.commit", "git.log", "git.reset",
        "patch.apply", "test.run"
      ],
      "policyTag": "coder",
      "maxToolIterations": 12,
      "model": "claude-opus-4-7",
      "timeoutMs": 600000,
      "tokenBudget": 200000
    }
  ]
}
```

Fields:

| Field               | Required | Notes |
|---------------------|----------|-------|
| `role`              | yes      | Unique role name. Used in `node.agentRole`. |
| `description`       | no       | Shown to the planner in the role catalog. |
| `systemPrompt`      | one of   | Inline prompt — wins if both are set. |
| `promptFile`        | one of   | Relative to `.maf/` (or absolute). Cached after first read. |
| `allowedTools`      | yes      | Must reference tool IDs that exist in the base registry — startup throws on unknown IDs. Enforced on the `in-process` tier; not passed to a `cli`-tier backend. Holding any write tool makes the role a writer (see [Writer roles](#writer-roles)). |
| `policyTag`         | no       | Optional tag for grouping in policy rules (currently informational). |
| `model`             | no       | Per-role model override. Beats the CLI's `--model`. |
| `timeoutMs`         | no       | Per-role timeout, otherwise the node's `timeoutMs` applies. |
| `tokenBudget`       | no       | Token cap. Enforced on the in-process path (real usage if reported, else estimated) and sent as `max_tokens`/`num_predict` by the HTTP adapters; the `claude`, `codex` and `gemini` CLIs have no such flag, so a `cli`-tier node ignores it. |
| `maxToolIterations` | no       | Cap on tool-call iterations (turns) in the loop. |
| `execution`         | no       | `'in-process'` or `'cli'`. Default: `'in-process'` for a [writer](#writer-roles), `'cli'` for any other role ([D-01](DECISIONS.md)). `in-process` routes the role through the gated `InProcessAgentLoop` (per-turn processor pipeline + policy gating + bounded malformed-tool-call repair) and needs a `TurnAdapter` with the `inProcessLoop` capability. Without one, a read-only role falls back to `cli` and notes the fallback in the run's transcript, while a writer refuses to start unless the run allows ungoverned writers (`--allow-ungoverned`). A writer set to `'cli'` needs the same flag. See the README "In-process execution" section. |
| `expectsChange`     | no       | `true` when the role's job is to change the tree ([D-32](DECISIONS.md)). A `cli`-tier node of such a role that answers and exits 0 but leaves no diff against its start commit fails with `no_change`, the output tail in the error — what a backend that refused the edit under its own permission settings looks like. Only a writer may set it; on any other role it is a `RoleConfigError`. The built-in `coder` and this repository's `.maf/roles.yaml` coder set it; the tester does not, because a tester that adds no test has often done its job. |

### YAML or JSON?

JSON, despite the extension. The parser removes lines whose first non-blank character is `#` and passes the rest to `JSON.parse`, so a JSON document with `#` comment lines loads and real YAML does not: a file in YAML syntax is a `RoleConfigError`, and the run stops. Policy files moved to a real YAML loader in 0.2.1; the roles file has not (it is on the README's Status table).

## How dispatch flows

```
planner.plan(task) → DAG with node.agentRole on each node
                     │
                     ▼
DagRunner.run({ executor: (node) => dispatcher.runNode(node) })
                     │
                     ▼
RoleDispatcher.runNode(node):
  1. role = roles.getRole(node.agentRole)            // node.agentRole is a RoleName: a role set defined it
  2. if isWriterRole(role):
       startCommit = git rev-parse HEAD              // captured before the node runs, once per node;
                                                     // a retry reuses it (empty tree if no commits yet)
  3. roleTools = new RoleToolRegistry(baseTools, role.allowedTools)
  4. rolePrompt = await roles.loadPrompt(role)
  5. systemPrompt = injector.assemble(node.label, sessionId, role.role) + '\n' + rolePrompt
  6. cli tier:        result = adapter.invoke({ prompt, systemPrompt, … })
     in-process tier: InProcessAgentLoop.run() — every tool call through executeToolGated;
                      for a writer, the security-gate processor runs the step-7 review at task_end
     if either throws (a timed-out turn, a backend that never started) and the role is a writer:
                      run the step-7 review now, then rethrow — a GateRefused outranks the error
  7. cli tier, writer role:
       diff = snapshotDiff(cwd, startCommit)         // whole repository vs startCommit;
                                                     // this run's .maf/ runtime state excluded
       result = await securityGate.reviewDiff(diff)  // GateRefused above the size cap
       attestor.recordSecurityFindings(node.id, result)
       if !result.passed: graph.addNode(Failure) + throw GateRefused
  8. fail the node: a cli result that carried a transport failure → TransportError (may be retried);
     one that reported failure, or a writer's empty output → NodeFailure;
     a loop that ended budget_exhausted without node.allowPartial → NodeFailure
```

`node.allowPartial` can be set only on a DAG built in code in 0.2.1: neither a DAG spec (`DagParser`), `DagSynthesizer` nor the planner sets it yet, so a planned run cannot accept partial work. Setting it from specs and plans is planned for 0.3.0.

The diff base is the commit captured in step 2, not `HEAD` at review time, so a writer that commits its own work is still reviewed. `RoleDispatcher.endNode(nodeId)`, called from the scheduler's `onNodeEnd`, forgets it.

On the `in-process` tier the dispatcher never bypasses policy: the loop advertises only the role's allowed tools, answers a call to any other tool with an error, and sends every allowed call through `executeToolGated` (in `@maf/tool-loop`), which asks the policy engine first. A role with `fs.write` in its allowlist can still be denied by a path-glob rule. On the `cli` tier none of this applies: the backend CLI runs its own tools, and MAF sees only a writer role's diff afterwards.

### Where policy sees the role

`ToolContext.agentRole` is set by `InProcessAgentLoop` from the role name `RoleDispatcher` hands it. Policy rules with `predicate.agentRole` then match exactly the role currently running the tool. Rules that omit `agentRole` apply to every role — backward-compatible with the pre-role policy file.

## Writer roles

A role is a writer when it holds any of `fs.write`, `fs.delete`, `patch.apply`, `git.commit`, `git.reset` or `git.add` (`isWriterRole`, exported from `@maf/roles`). The role's name plays no part: a `tester` holding `patch.apply` and a custom role holding only `git.commit` are writers; a role called `coder` with only read tools is not. For a writer, MAF:

- runs it on the `in-process` tier unless its `execution` is `'cli'` ([D-01](DECISIONS.md)): policy verdicts, secret redaction, attested tool calls and processor hooks exist only there. A writer that would land on the `cli` tier — by its own `execution: 'cli'`, or because the adapter cannot run the in-process loop (Codex and Gemini cannot) — refuses to start, before it captures anything or calls a model, with an error naming `--allow-ungoverned`. With that flag it runs on the `cli` tier, the run prints an `UNGOVERNED` banner on stderr once, and the transcript notes each such node. `effectiveTier(role, adapter)` says which tier a role gets;
- captures the start commit before the node runs, so the target directory must be a git repository;
- security-reviews the diff once per attempt: on the `cli` tier after the backend returns, whatever it returned; on the `in-process` tier at `task_end` through the `security-gate` processor, or right after the loop when a harness's own bundle leaves that processor out; and, on either tier, before an error thrown by the backend or the loop propagates ([D-31](DECISIONS.md)). A tool or a backend turn that throws inside the loop still fires `task_end`, so every processor sees the task end;
- fails the node on the `cli` tier if the backend returns empty output, or — for a role with `expectsChange` — if it answers and leaves the tree unchanged against the start commit (`no_change`, [D-32](DECISIONS.md)).

The scheduler's writer lock — which stops two nodes editing the tree at once — uses a broader test, `isWriterForLock(role, adapter, baseTools)`: every role that runs on the `cli` tier counts as a writer there, because its backend CLI has file tools of its own whatever the allowlist says — including a read-only role that asked for `in-process` on an adapter that cannot run it — and an `in-process` role counts as one if it holds any tool that is not read-only.

## Planning instructions

`RetrievalAugmentedPlanner` is given the role set in force — which supplies both the default role and the answer to "is this name real?" — plus an optional `roleCatalog` for wording. The planner's system prompt enumerates the catalog and tells the LLM:

> After any coder node that introduces new behavior, emit a tester node that depends on it.
>
> When a task touches authentication, parsing of user input, secrets, or external network calls, emit an explicit security node. (A lightweight automatic security scan also runs on every writer role's diff.)

If the LLM emits a node with `agentRole: "ghost"` and the role set does not define `ghost`, the plan is **rejected**: `plan()` throws `planner: node "n1" asks for unknown agentRole "ghost". Known roles: coder, tester, ...`. Substituting the default was the escalation — the default is `coder`, a writer — so a plan the model got wrong must not be quietly re-planned as a privileged one.

## Read-only roles

The policy this repository ships (`.maf/policy.yaml`) includes:

```yaml
- id: deny-readonly-roles
  description: Reviewer and security roles are read-only
  priority: 85
  predicate:
    agentRole: [reviewer, security]
    toolId: [fs.write, patch.apply, fs.delete, git.add, git.commit, git.reset]
  action:
    kind: Deny
    reason: Read-only role cannot mutate state
```

That is belt-and-suspenders with the tool allowlist: even if a future role config grants `fs.write` to `reviewer`, the policy will deny the call on the `in-process` tier.

## Authoring a new role

1. Add the role to `.maf/roles.yaml`.
2. Drop a prompt file at `.maf/prompts/<role>.md` (or inline it as `systemPrompt`).
3. Pick the tool allowlist conservatively — start with what's strictly needed. Any write tool makes the role a [writer](#writer-roles).
4. Add a policy rule with `predicate.agentRole: "<role>"` for any path/operation restrictions that aren't already implied by the tool list.
5. (Optional) Set `model`, `timeoutMs`, or `maxToolIterations` if the role has special performance needs.

The planner picks up the new role automatically through `roles.catalog()`.
