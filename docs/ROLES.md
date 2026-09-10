# Roles

Every DAG node in MAF runs as a *role*. A role bundles:

1. A **system prompt** (inline or loaded from a file).
2. An **allowed tool set** — the only tools the role is allowed to call.
3. Optional **model**, **timeout**, **token budget**, and **policyTag** overrides.

The planner emits `agentRole` on each node it produces. The `RoleDispatcher` resolves that string against the registry; unknown roles fall back to the default with a warning.

## Default roles

The built-in `DEFAULT_ROLE_SET` (`packages/roles/src/defaults.ts`) ships four roles. They are used when `.maf/roles.yaml` is absent or the named role isn't found.

| Role       | Writable? | Allowed tools                                                                                                                  | Use for                              |
|------------|-----------|--------------------------------------------------------------------------------------------------------------------------------|--------------------------------------|
| `coder`    | yes       | `fs.read`, `fs.write`, `fs.delete`, `fs.stat`, `fs.list`, `grep`, `git.{status,diff,add,commit,log,reset}`, `patch.apply`, `test.run` | Writing & modifying production code  |
| `tester`   | yes\*     | `fs.read`, `fs.list`, `fs.stat`, `grep`, `test.run`, `patch.apply`, `fs.write`                                                | Writing tests only                   |
| `security` | no        | `fs.read`, `fs.list`, `fs.stat`, `grep`, `git.diff`, `git.log`                                                                 | CWE/OWASP audit, JSON-only output    |
| `reviewer` | no        | `fs.read`, `grep`, `git.diff`, `git.log`                                                                                       | Code review, approve/reject diffs    |

\* The tester role *can* be granted write tools, but policy enforces that any write target must match `**/*test*`, `**/*spec*`, `**/tests/**`, or `**/__tests__/**`. The tool allowlist and the policy work together — neither alone is sufficient.

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
| `allowedTools`      | yes      | Must reference tool IDs that exist in the base registry — startup throws on unknown IDs. |
| `policyTag`         | no       | Optional tag for grouping in policy rules (currently informational). |
| `model`             | no       | Per-role model override. Beats the CLI's `--model`. |
| `timeoutMs`         | no       | Per-role timeout, otherwise the node's `timeoutMs` applies. |
| `tokenBudget`       | no       | Adapter-specific token cap. |
| `maxToolIterations` | no       | Cap on tool-call iterations in `ToolLoop`. |

### YAML or JSON?

The parser strips `#` comment lines and runs `JSON.parse`. That accepts a `.json` document directly and tolerates `.yaml` only when its content is a strict-JSON subset with comments. To use real YAML, install a YAML parser and pre-process — the file lives at `.maf/roles.yaml` for forward compatibility, but the current parser is JSON-only. Mirrors the same approach used by `@maf/policy-engine`.

## How dispatch flows

```
planner.plan(task) → DAG with node.agentRole on each node
                     │
                     ▼
DagRunner.run({ executor: (node) => dispatcher.runNode(node) })
                     │
                     ▼
RoleDispatcher.runNode(node):
  1. role = roles.getRole(node.agentRole)            // unknown → default + warn
  2. roleTools = new RoleToolRegistry(baseTools, role.allowedTools)
  3. rolePrompt = await roles.loadPrompt(role)
  4. systemPromptPrefix = injector.assemble(node.label, sessionId, role.role)
  5. systemPrompt = systemPromptPrefix + '\n' + rolePrompt
  6. adapter.invoke({ prompt, systemPrompt, tools: roleTools.getAll(), … })
  7. if role.role === 'coder':
       diff = git diff HEAD
       result = await securityGate.reviewDiff(diff)
       attestor.recordSecurityFindings(node.id, result)
       if !result.passed: graph.addNode(Failure) + throw
```

The dispatcher never bypasses policy. `RoleToolRegistry.getAll()` only advertises the role's allowed tools to the adapter, and `ToolLoop.executeTool` (in `@maf/tool-loop`) re-checks policy for every call. A role with `fs.write` in its allowlist can still be denied by a path-glob rule.

### Where policy sees the role

`ToolContext.agentRole` is set by `ToolLoop` from `ToolLoopConfig.agentRole`, which `RoleDispatcher` populates from the resolved role. Policy rules with `predicate.agentRole` then match exactly the role currently running the tool. Rules that omit `agentRole` apply to every role — backward-compatible with the pre-role policy file.

## Planning instructions

`RetrievalAugmentedPlanner` is given a `roleCatalog` and a set of `validRoles`. The planner's system prompt enumerates the catalog and tells the LLM:

> After any coder node that introduces new behavior, emit a tester node that depends on it.
>
> When a task touches authentication, parsing of user input, secrets, or external network calls, emit an explicit security node. (A lightweight automatic security scan also runs on every coder diff.)

If the LLM emits a node with `agentRole: "ghost"` and `ghost` isn't in `validRoles`, `parsePlan` substitutes the default role and prints a `[planner] unknown agentRole "ghost"` warning instead of throwing.

## Read-only roles

The default policy bundle (`.maf/policy.yaml`) includes:

```json
{
  "id": "deny-readonly-roles",
  "priority": 85,
  "predicate": {
    "agentRole": ["reviewer", "security"],
    "toolId": ["fs.write", "patch.apply", "fs.delete", "git.add", "git.commit", "git.reset"]
  },
  "action": { "kind": "Deny", "reason": "Read-only role cannot mutate state" }
}
```

That is belt-and-suspenders with the tool allowlist: even if a future role config grants `fs.write` to `reviewer`, the policy will deny the call.

## Authoring a new role

1. Add the role to `.maf/roles.yaml`.
2. Drop a prompt file at `.maf/prompts/<role>.md` (or inline it as `systemPrompt`).
3. Pick the tool allowlist conservatively — start with what's strictly needed.
4. Add a policy rule with `predicate.agentRole: "<role>"` for any path/operation restrictions that aren't already implied by the tool list.
5. (Optional) Set `model`, `timeoutMs`, or `maxToolIterations` if the role has special performance needs.

The planner picks up the new role automatically through `roles.catalog()`.
