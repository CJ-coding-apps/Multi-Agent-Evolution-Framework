# Policy

The policy engine intercepts every tool call from inside `ToolLoop.executeTool` and returns one of three verdicts:

| Verdict     | What happens |
|-------------|--------------|
| `Allow`     | Tool runs normally. |
| `Deny`      | `PolicyViolationError` is thrown; the agent sees the rule's `reason`. |
| `Escalate`  | An `ApprovalRequest` is generated; `@maf/approval-gate` decides whether to wait, prompt the human, or auto-fail. |

Rules are evaluated in **descending priority** order. The first rule whose predicate matches the call wins. If no rule matches, the verdict is `Allow`.

## Rule shape

```json
{
  "id": "tester-write-only-tests",
  "description": "Tester role may only write/patch files matching test path globs",
  "priority": 80,
  "predicate": {
    "agentRole": "tester",
    "toolId": ["fs.write", "patch.apply", "fs.delete"],
    "allowedPathGlobs": [
      "**/*test*", "**/*spec*", "**/tests/**", "**/__tests__/**"
    ]
  },
  "action": { "kind": "Deny", "reason": "Tester role may only modify test files" }
}
```

`id` and `priority` are required. The rest is documented below.

## Predicate fields

All are optional. A rule with **no** predicate fields matches every tool call — usually a footgun, but useful in tests.

### `toolId`

```json
"toolId": "fs.write"
"toolId": ["fs.write", "patch.apply"]
```

Match a single tool or any of a list. Omitted → matches every tool.

### `agentRole`

```json
"agentRole": "tester"
"agentRole": ["security", "reviewer"]
```

Match the role currently running the tool (`ToolContext.agentRole`). Omitted → matches every role *including* unspecified. Note the asymmetry with `toolId`: an omitted role predicate is a wildcard, but a role-predicate that *can't* match (because the context has no `agentRole`) returns false. That keeps role-targeted rules from accidentally firing on legacy code that doesn't set `agentRole`.

### `pathGlob`

```json
"pathGlob": "**/.env*"
```

A single minimatch pattern checked against each path in the tool input. Matches if **any** input path matches. Input paths are collected from:

1. `input.paths` if it's a string[].
2. `input.path` if it's a string.
3. `input.paths` if it's a string (single path).

`patch.apply` populates `input.paths` from the diff headers automatically (`extractDiffPaths`), so path-glob rules apply to every file the patch touches, not just whatever the caller passed in.

### `allowedPathGlobs`

```json
"allowedPathGlobs": ["**/*test*", "**/tests/**"]
```

Inverted semantics. The rule matches when **any** input path falls *outside* every allowed pattern. Pair with a `Deny` action to express:

> This role may only modify files matching one of these patterns; deny anything else.

Without inverted semantics, the alternative is a brittle negated minimatch glob (`!`). The asymmetry is intentional — see the migration notes in [ROLES.md](ROLES.md).

When `pathGlob` and `allowedPathGlobs` are both set, **both** must hold for the rule to match. (Both are positive checks against the same input paths.)

### `memoryPattern`

```json
"memoryPattern": {
  "cypher": "MATCH (f:Failure {nodeId: $taskId, kind: 'Security'}) RETURN f LIMIT 1"
}
```

The string is template-substituted before execution:

| Placeholder | Replaced with                                       |
|-------------|-----------------------------------------------------|
| `$tool`     | `'<toolId>'`                                        |
| `$path`     | `'<input.path>'` (single-quotes escaped)            |
| `$runId`    | `'<ctx.runId>'`                                     |
| `$taskId`   | `'<ctx.taskId>'`                                    |

The rule matches if the query returns at least one row. Errors are swallowed (treated as no match) so a broken Cypher rule doesn't take down a run.

### `minFailureCount`

Reserved for graph-derived predicates that count prior failure rows. Currently unused by the engine — passes through without enforcement.

## Actions

```json
"action": { "kind": "Allow" }
"action": { "kind": "Deny", "reason": "<text>", "alternative": "<toolId>" }
"action": { "kind": "Escalate", "requiresApproval": true }
```

- `Allow` produces an `Allow` verdict and short-circuits further evaluation.
- `Deny` includes the rule's `reason` in the thrown error. The optional `alternative` is surfaced to the agent (e.g. "use `patch.apply` instead of `fs.write`").
- `Escalate` generates an `ApprovalRequest` keyed to `ruleId`. Expiry is 24 hours.

## Default rules in `.maf/policy.yaml`

The shipped policy bundle:

| Priority | ID | Effect |
|----------|----|--------|
| 100 | `deny-env-files` | Deny `fs.write` to `**/.env*`. |
| 95  | `protect-lock-files` | Escalate writes/patches to `**/*.lock`. |
| 90  | `protect-migrations` | Escalate writes/patches to `**/migrations/**`. |
| 90  | `coder-no-secrets-dir` | Deny `coder` writes to `**/secrets/**`. |
| 85  | `deny-readonly-roles`  | Deny mutating tools for `reviewer`/`security`. |
| 80  | `tester-write-only-tests` | Deny `tester` writes outside test path patterns. |

Priorities are conventional, not enforced: keep them widely spaced so rules can be inserted between them later without renumbering.

## Backward compatibility

A rule with no `agentRole` matches every role and every legacy code path. Pre-role policy files keep working unchanged. Adding a role-scoped rule does not affect rules above it in priority.

## Common patterns

**Restrict a role to a path prefix:**

```json
{
  "id": "docs-writer-docs-only",
  "priority": 80,
  "predicate": {
    "agentRole": "docs-writer",
    "toolId": ["fs.write", "patch.apply"],
    "allowedPathGlobs": ["docs/**", "**/*.md"]
  },
  "action": { "kind": "Deny", "reason": "docs-writer may only modify docs" }
}
```

**Require approval before modifying any code in a specific directory:**

```json
{
  "id": "platform-needs-review",
  "priority": 70,
  "predicate": { "pathGlob": "packages/platform-core/**" },
  "action": { "kind": "Escalate", "requiresApproval": true }
}
```

**Block a tool from a role even if the role's allowlist somehow grants it:**

```json
{
  "id": "tester-no-deletes",
  "priority": 90,
  "predicate": { "agentRole": "tester", "toolId": "fs.delete" },
  "action": { "kind": "Deny", "reason": "tester cannot delete files" }
}
```

## How verdicts are produced

```
ToolLoop.executeTool(toolId, input, ctx)
  ↓
PolicyEngine.evaluate(toolId, input, ctx)
  → for each rule in priority order:
      if !matchesToolId        : skip
      if !matchesAgentRole     : skip
      if !matchesPath          : skip
      if !matchesAllowedPaths  : skip
      if memoryPattern set and Cypher returns 0 rows : skip
      → buildDecision(rule.action) → return
  → no rules matched → { verdict: 'Allow' }
```

A `Deny` verdict throws `PolicyViolationError` from `ToolLoop`. An `Escalate` verdict pauses for approval through `@maf/approval-gate`. An `Allow` verdict lets the tool run, and the call is appended to the run's tool-invocation log on the memory graph (via `Attestor.record`).
