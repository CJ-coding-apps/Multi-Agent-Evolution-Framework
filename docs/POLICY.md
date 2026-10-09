# Policy

On the `in-process` tier, every tool call a role makes passes through `executeToolGated` (`@maf/tool-loop`), which asks the policy engine for a verdict before the tool runs. Only `Allow` runs the tool, or an `Escalate` a person approves; every other verdict refuses the call. (On the `cli` tier — where a read-only role runs by default, and a writer only under `--allow-ungoverned` — the backend CLI runs its own tools and no policy applies at all; see [SECURITY.md](SECURITY.md#the-execution-tier-boundary).)

| Verdict         | What happens |
|-----------------|--------------|
| `Allow`         | The tool runs, and the call is recorded in the attestation bundle. |
| `Deny`          | The tool does not run. The refusal is recorded in the bundle with the id of the rule that denied (a confinement `Deny`, which no rule decides, has none), and the model is told `policy Deny: <reason>`. |
| `Escalate`      | A person at the terminal is asked about this one call, and it runs only if they approve it. Refused as `Deny` is — with the rule id, and the decision recorded — when they do not, when no one answers in time, when the run is headless, or when the run has no approval gate. See [Escalate: asking a person](#escalate-asking-a-person). |
| `Indeterminate` | The policy could not be evaluated: a rule's `memoryPattern` query failed, or named a parameter that cannot be bound. Refused like `Deny`, and recorded with the rule id. |

A refused call is thrown inside `executeToolGated` as `PolicyViolationError`; the in-process loop turns that into an error result for the model, and the loop carries on. A call to a tool outside the role's allowlist never reaches the policy engine: the loop answers it with an error before policy, and it is not recorded in the bundle.

Rules are evaluated in **descending priority** order. The first rule whose predicate matches the call wins. If no rule matches, the verdict is `Allow`.

## The policy file

`maf run` reads `.maf/policy.yaml` in the target directory, or the file `--policy <path>` names (resolved against the target directory). `PolicyLoader` (`packages/policy-engine/src/PolicyLoader.ts`) loads it with a real YAML parser; JSON is valid YAML, so a JSON policy file loads too.

- **A missing file** prints one warning line and loads no rules. Path confinement (below) still applies.
- **A file that exists but cannot be used stops the run**: one that cannot be read, is not valid YAML, or fails validation. The error carries the parse error, or every validation problem at once. An empty or comment-only file is refused; write `rules: []` to run with no rules on purpose.
- **Validation.** Each rule needs `id` (unique across the file), `priority` (a finite number), `predicate` (a mapping; `{}` matches every call) and `action`; `description` is optional. A `Deny` action needs `reason`, and an `Escalate` action needs `requiresApproval` (`true` or `false`) — although the engine does not read it: an `Escalate` rule asks for approval whichever it says. An unknown field is refused wherever it appears — the document, a rule, a predicate, a `memoryPattern`, an action — because a misspelt `agentRole` would otherwise widen a rule to every role. An empty glob and an empty list are refused too: the engine would read either as "no condition".
- **Quote every glob.** YAML reads a bare value starting with `*` as an alias and one starting with `{` as a mapping.

## Rule shape

```yaml
rules:
  - id: tester-write-only-tests
    description: Tester role may only write/patch files matching test path globs
    priority: 80
    predicate:
      agentRole: tester
      toolId: [fs.write, patch.apply, fs.delete]
      allowedPathGlobs:
        - "**/*test*"
        - "**/*spec*"
        - "**/tests/**"
        - "**/__tests__/**"
    action:
      kind: Deny
      reason: Tester role may only modify test files
```

`id`, `priority`, `predicate` and `action` are required. The rest is documented below.

## Predicate fields

All are optional. A rule whose predicate is `{}` matches every tool call — usually a footgun, but useful in tests.

### `toolId`

```yaml
toolId: fs.write
toolId: [fs.write, patch.apply]
```

Match a single tool or any of a list. Omitted → matches every tool.

### `agentRole`

```yaml
agentRole: tester
agentRole: [security, reviewer]
```

Match the role currently running the tool (`ToolContext.agentRole`, which `InProcessAgentLoop` sets from the role it runs). Omitted → matches every role *including* unspecified. Note the asymmetry with `toolId`: an omitted role predicate is a wildcard, but a role-predicate that *can't* match (because the context has no `agentRole`) returns false. That keeps role-targeted rules from accidentally firing on legacy code that doesn't set `agentRole`.

### Paths are confined before any rule

Before the rule list is read, every path the tool declared is resolved against `ctx.projectRoot` and
proven to lie inside it, by `resolveInside` (`@maf/types`, `packages/types/src/paths.ts`). The rules
below then see the **resolved, root-relative** path — not the string the caller typed.

Two things follow, and both are the point:

- **A path that leaves the root is refused**, with a `Deny`, whether or not any rule is loaded. A path
  outside the project root — `/etc/.env`, `../.env`, or a symlink whose name is inside and whose target
  is not — is a decision about the call, not a failure to reach one, so it is `Deny` rather than
  `Indeterminate`, and it is not escalatable. Because it does not depend on a rule, an empty policy file
  does not switch confinement off. No rule decided it, so its record in the bundle carries no rule id.
- **One file has one spelling.** `.env`, `./.env`, `a/../.env` and `sub/../.env` all resolve to `.env`
  before a glob is matched. A glob is written against a path, so before this it matched only the
  spellings a caller happened to use: `**/.env*` denied `.env` and allowed `./.env` and `../.env`.

The fs tools apply the same check in `execute` (`packages/tools/src/plugins/fs.ts`), so a direct tool
call that never went through the policy engine is no less confined. For the `fs.*` tools the checked
path and the executed path are the same value, because both come from `resolveInside` on the same
input. `git.diff` declares and diffs one list (`paths`). `git.add`, `grep` and `patch.apply` are
confined by the policy engine only: it checks the resolved form of what they declare, and the tool then
passes its own input to git (with literal pathspecs), to rg or grep (after `--`), or to `patch`. That is
the same input, but not one resolved value.

### `pathGlob`

```yaml
pathGlob: "**/.env*"
```

A single minimatch pattern checked against the paths the tool **declares** for this call, after they have
been resolved and confined as described above. Matches if **any** declared path matches. Globs are
matched with `{ dot: true }`, so `*` and `**` match path segments that start with a dot: `**/secrets/**`
covers `secrets/.hidden`, and `**/*test*` covers `.github/workflows/test.yml`.

Declared paths come from the tool itself — `ToolPlugin.declaredPaths(input)`, a pure function of the input that the policy layer calls before any rule is consulted. It is not a guess made from which input keys look path-like:

- `fs.*` declare `input.path`.
- `grep` declares `input.path`, or `.` when it searches the whole working directory.
- `git.diff` declares `input.paths` (a legacy `input.path` is merged into it), and diffs exactly that list.
- `git.add` declares `input.paths` (or `input.path`).
- `patch.apply` declares every file in the diff headers (`extractDiffPaths`), so a path-glob rule applies to every file the patch touches, not just whatever the caller passed in.
- `git.status` / `git.commit` / `git.log` / `git.reset` and `test.run` act on the repository or project as a whole and declare `[]`, so no path rule can match them. Their inputs are checked by the tools instead: `git.log` accepts only a positive whole number of commits, and `git.reset` only a hex object name, `HEAD`, `HEAD~N`, `HEAD^N` or a branch or tag name not starting with `-`, which it passes before a trailing `--` so git reads it as a revision ([D-28](DECISIONS.md): not `--end-of-options`, which `git reset` accepts only from git 2.44).

Four consequences worth stating:

- A path that cannot be confined refuses the whole call, so one escaping path in a multi-path declaration is enough to deny it.
- A declaration of `[]` has nothing to confine, so confinement has no path to refuse either.
- A rule with a `pathGlob` **cannot match a call that declares no path** — matching on an empty set would make a Deny rule fire on calls that named no file.
- A rule matches if **any** declared path matches. A multi-file call (a patch spanning `src/a.ts` and `.env`) is denied by a `**/.env*` rule, because one of its declared paths matches.

### `allowedPathGlobs`

```yaml
allowedPathGlobs: ["**/*test*", "**/tests/**"]
```

Inverted semantics. The rule matches when **any** declared path falls *outside* every allowed pattern. The paths are the resolved ones (see above), so `./tests/util.ts` and `tests/util.ts` are the same path here — before, the `./` spelling matched neither allowed glob and the rule read it as outside the tree it was inside.

> This role may only modify files matching one of these patterns; deny anything else.

Without inverted semantics, the alternative is a brittle negated minimatch glob (`!`). The asymmetry is intentional — see the migration notes in [ROLES.md](ROLES.md).

When `pathGlob` and `allowedPathGlobs` are both set, **both** must hold for the rule to match. (Both are positive checks against the same confined paths.)

### `memoryPattern`

```yaml
memoryPattern:
  cypher: "MATCH (f:MemoryNode {kind: 'Failure', run_id: $runId}) RETURN f.id LIMIT 1"
```

The query runs against the memory graph, where every node is a `MemoryNode` with `kind`, `label`,
`run_id` and a JSON `properties` string (`packages/memory-graph/src/schema.ts`). The example matches
once the current run has recorded a `Failure` node, which the security gate writes when it refuses a
change. A query naming a table the schema does not have fails, and so refuses every call the rule's
other predicates match (see below).

The placeholders are bound as query parameters, never spliced into the query text:

| Placeholder | Bound to                                            |
|-------------|-----------------------------------------------------|
| `$tool`     | the tool id                                         |
| `$path`     | the first declared path (resolved, root-relative)   |
| `$runId`    | `ctx.runId`                                         |
| `$taskId`   | `ctx.taskId`                                        |

The rule matches if the query returns at least one row. If the query fails, or names a parameter that cannot be bound (a typo like `$filePath`), the verdict is `Indeterminate` and the call is refused: a broken graph query must not silently switch a `Deny` rule off.

### `minFailureCount`

Reserved for graph-derived predicates that count prior failure rows. Currently unused by the engine — passes through without enforcement.

## Actions

```yaml
action: { kind: Allow }
action: { kind: Deny, reason: "<text>", alternative: "<toolId>" }
action: { kind: Escalate, requiresApproval: true }
```

- `Allow` produces an `Allow` verdict and short-circuits further evaluation.
- `Deny` includes the rule's `reason` in what the model is told, and carries the rule's id. The optional `alternative` is carried on the decision (e.g. "use `patch.apply` instead of `fs.write`").
- `Escalate` builds an `ApprovalRequest` keyed to `ruleId` (`requiresApproval: false` changes nothing), and the call then waits on the approval gate, as described in [Escalate: asking a person](#escalate-asking-a-person). The request's 24-hour `expiresAt` is not what limits the wait; the gate's own timeout is.

## Escalate: asking a person

`Escalate` is the one refusal a person can lift, and only for the call in front of them ([D-02](DECISIONS.md)). `executeToolGated` hands the run's approval gate (`@maf/approval-gate`) the request, the tool id, the input the tool will run on and the paths it declared. `maf run` builds one gate per run, which asks at the terminal when stdin is one and `MAF_HEADLESS=1` is not set, and is headless otherwise; `maf goldens`, `maf evolve` and `maf inprocess-demo` always build a headless one. A caller of `executeToolGated` that passes no gate gets `Escalate` refused as `Deny` is.

- **On a terminal** (stdin is a TTY), the gate prompts on stderr with the rule id, the tool id, the declared paths, a preview of the input, the request id and the request hash, and waits. The preview shows each input field escaped, up to its first 20 lines or 2,000 characters, whichever is less (a string as its lines, anything else as compact JSON), and counts the bytes it leaves out; past the eighth field, fields are counted rather than shown. Escaping covers control characters, so nothing in the input can redraw the prompt. The hash covers the whole input. Approving is typing the six-character confirmation code printed in that prompt. Any other answer, an empty line or a closed terminal refuses. The code is made for that one request, so a `y` typed ahead, or a code typed twice, approves nothing. One approval prompt is shown at a time.
- **Headless** (stdin is not a TTY, or `MAF_HEADLESS=1`), no one is asked: the call is refused at once, and the request is written to `.maf/approvals/pending/<id>.json` in the target directory (not the run's worktree) — the request, its hash, the tool id, the declared paths, a timestamp and why, but not the tool's input — for audit. The file is a record, not a queue; approving it later approves nothing.
- **Timeout.** No answer within 120 seconds of the prompt appearing (the gate's `timeoutMs` option, which `maf run` leaves at its default) refuses the call with status `TimedOut`, and the gate stops reading the terminal. A request waiting behind another prompt is not timed until its own prompt is shown.

A decision is bound to its request. The request hash is sha256 over the canonical JSON (object keys sorted; plain JSON values only) of the tool id, the input, the declared paths and the rule id. The gate refuses a decision carrying another hash, a decision for another request, a request id it has seen before, and an input that changed while the person was deciding. An approval runs the call once: the same call made again is a new request, and is asked about again.

Every decision — approved, refused, timed out, refused headless, or refused by the gate's own checks — is added to the attestation bundle's `approvals` as a `ReviewAttestation`. Its `requestId` is the call's `policyDecision.approvalRequest.id`; `decision.status` is `Approved`, `Rejected` or `TimedOut`; `decision.reviewer` is `terminal:<user>`, `headless` or `maf-approval-gate`; `decision.comment` says why; `diffHash` is the request hash. `commitHash` is all zeros, because an approval binds a tool call, not a commit. An approved call is then recorded in `toolCalls` like any call that ran, with its `Escalate` verdict; a refused one carries `metadata.refused: true` and `metadata.approval`, the decision's status.

GitHub pull-request review is not an approval channel in 0.3.0. The earlier code that read a merged pull request as an approval is removed.

## Default rules in `.maf/policy.yaml`

The policy shipped in this repository:

| Priority | ID | Effect |
|----------|----|--------|
| 1000 | `deny-git-dir` | Deny `fs.write`, `fs.delete`, `patch.apply` and `git.add` on `{**/.git,**/.git/**}` — a `.git` directory or file at any depth — for every role. |
| 1000 | `deny-maf-dir` | Deny `fs.write`, `fs.delete`, `patch.apply` and `git.add` on `{.maf,.maf/**}` — the project's own MAF state — for every role. |
| 100 | `deny-env-files` | Deny `fs.write` to `**/.env*`. |
| 95  | `protect-lock-files` | Escalate (ask a person) writes/patches to `**/*.lock`. |
| 90  | `protect-migrations` | Escalate (ask a person) writes/patches to `**/migrations/**`. |
| 90  | `coder-no-secrets-dir` | Deny `coder` writes to `**/secrets/**`. |
| 85  | `deny-readonly-roles`  | Deny mutating tools for `reviewer`/`security`. |
| 81  | `tester-no-ci-config` | Deny `tester` writes/patches/deletes under `{.github,.github/**}`: once globs matched dotfiles, `**/*test*` reached `.github/workflows/test.yml`, which is CI configuration, not a test ([D-30](DECISIONS.md)). |
| 80  | `tester-write-only-tests` | Deny `tester` writes outside test path patterns. |

The two priority-1000 rules exist because anything written into `.git/` — a hook, or `core.hooksPath` in `.git/config` — runs outside every gate, and `.maf/` holds the policy, roles and run records an agent could otherwise rewrite. A coder commits through the gated `git.commit` tool instead; `.gitignore`, `.gitattributes` and a `.githooks/` directory stay writable, and reads are unaffected.

Priorities are conventional, not enforced: keep them widely spaced so rules can be inserted between them later without renumbering. Two rules may share a priority; their relative order is then not something to rely on.

## Backward compatibility

A rule with no `agentRole` matches every role and every legacy code path. Pre-role policy files keep working unchanged, provided they pass validation. Adding a role-scoped rule does not affect rules above it in priority.

## Common patterns

Each example is one entry in the file's `rules:` list.

**Restrict a role to a path prefix:**

```yaml
- id: docs-writer-docs-only
  priority: 80
  predicate:
    agentRole: docs-writer
    toolId: [fs.write, patch.apply]
    allowedPathGlobs: ["docs/**", "**/*.md"]
  action:
    kind: Deny
    reason: docs-writer may only modify docs
```

**Mark a directory as needing approval** (a person is asked on a terminal; a headless run refuses):

```yaml
- id: platform-needs-review
  priority: 70
  predicate:
    pathGlob: "packages/platform-core/**"
  action:
    kind: Escalate
    requiresApproval: true
```

**Block a tool from a role even if the role's allowlist somehow grants it:**

```yaml
- id: tester-no-deletes
  priority: 90
  predicate:
    agentRole: tester
    toolId: fs.delete
  action:
    kind: Deny
    reason: tester cannot delete files
```

## How verdicts are produced

```
executeToolGated(tool, input, ctx)                 // @maf/tool-loop
  ↓ declaredPaths = tool.declaredPaths(input)
PolicyEngine.evaluate(toolId, input, ctx, declaredPaths)
  → confine every declared path against ctx.projectRoot
      → any path escapes or cannot be resolved: { verdict: 'Deny' }   ← no rule needed
  → for each rule in priority order:
      if !matchesToolId        : skip
      if !matchesAgentRole     : skip
      if !matchesPath          : skip
      if !matchesAllowedPaths  : skip
      if memoryPattern set:
          query fails          : { verdict: 'Indeterminate', ruleId }  → return
          query returns 0 rows : skip
      → buildDecision(rule.action) → return
  → no rules matched → { verdict: 'Allow' }
  ↓
verdict === 'Escalate', with a gate : approvalGate.decide → approved: run as Allow does
verdict !== 'Allow', not approved   : attestor.record(refusal) → throw PolicyViolationError
verdict === 'Allow'                 : tool.execute → redact secrets → attestor.record(call)
```

Anything but `Allow`, and an `Escalate` the gate did not approve, is attested as a refusal (`metadata.refused: true`, with the rule id where a rule decided) and then thrown as `PolicyViolationError`, which the in-process loop reports to the model as an error. An `Allow` verdict lets the tool run; the call is then recorded in the attestation bundle and as a `ToolInvocation` node on the memory graph (via `Attestor.record`), as a refusal is.
