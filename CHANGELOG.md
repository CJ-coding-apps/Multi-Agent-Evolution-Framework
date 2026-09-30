# Changelog

Notable changes to maf. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

maf is pre-1.0 with no known outside users, so breaking changes land in the unreleased section
rather than behind a major bump. They are still listed as breaking, because a reader of this file
is entitled to know which of their own code stops compiling.

## [Unreleased]

### Breaking

- **`ToolPlugin.declaredPaths(input)` is now required.** A tool must state the filesystem paths a
  call will touch, as a pure function of its input. `BaseTool` declares it abstract, so a subclass
  that forgets it fails to compile rather than silently declaring nothing. Fixes D-05:
  `patch.apply` derived its paths *inside* `execute` and wrote them back onto the input, so
  `PolicyEngine.evaluate` — which runs before `execute` — saw no paths, and the shipped
  `protect-secrets` Deny rule (`pathGlob: "**/.env*"`) blocked `fs.write ".env"` while allowing a
  patch that wrote the same file. `grep`, `git.diff` and `git.add` gain a path surface they did not
  have; `git.status`/`commit`/`log`/`reset` and `test.run` declare `[]` deliberately. See
  [docs/POLICY.md](docs/POLICY.md) and [docs/SECURITY.md](docs/SECURITY.md).

- **`PolicyEngineHandle.evaluate(toolId, input, ctx, declaredPaths)` takes a fourth, required
  argument.** The declaration comes from the calling tool, so no call site can leave path rules
  with nothing to match against. The single production caller is `executeToolGated`.

- **A `RoleName`, not a `string`, is what identifies a role.** `DagNode.agentRole`,
  `RoleConfig.role`, `RoleSet.defaultRole` and `RoleCatalogEntry.role` are now `RoleName`; it is
  produced only where a role set is *defined* (the built-in `DEFAULT_ROLE_SET`, a parsed
  `roles.yaml`, a harness's role set — all through `@maf/roles`' `defineRoleName`) or by
  `RoleResolver.resolveRole(name)`. Fixes D-07: `RoleRegistry.getRole` answered a name it did not
  recognise with the **default** role — `coder`, which holds `fs.write`, `fs.delete`, `git.commit`
  and `patch.apply` — so a hallucinated role name *widened* privilege, and the planner's
  warn-then-continue path was the same path. Migration:

  - `getRole(name: RoleName)` still exists and returns the config for a name the set minted; a
    name from another set is a `RoleConfigError`. Use `resolve(name): Result<ResolvedRole,
    UnknownRole>` when the name is untrusted input — it is the only entry point that answers
    "does this set define it?" without throwing.
  - `RoleRegistry.hasRole` is unchanged; `names()` and `list()` now carry `RoleName`s.
  - `DagParser.fromSpec`/`fromMarkdown*`/`fromYamlText` no longer take a `defaultRole: string` —
    they take a `RoleResolver`, which supplies the default *and* the refusal. Same for
    `DagSynthesizer`'s constructor.
  - `PlannerConfig.defaultRole?: string` and `validRoles?: ReadonlySet<string>` are replaced by a
    required `roles: RoleResolver`.
  - A node naming an unknown role is **refused** where the DAG is built (`DagParser`,
    `DagSynthesizer`, the planner) instead of silently becoming `coder`. `RoleDispatcher`'s
    `agentRole` handling and the goldens `TaskDispatcher` do the same, both naming the roles that
    do exist.

  The guarantee is enforced, not documented: `@maf/roles`' `role-name-mint` test fails if `as
  RoleName` appears anywhere but `RoleConfig.ts`, or if `defineRoleName` is called by a file that
  does not define a role set. See [docs/ROLES.md](docs/ROLES.md).

- **Graph access is one interface that binds its parameters; there is no escaper.** Fixes D-08,
  D-20, D-19. `esc()` — `.replace(/'/g, "''")`, SQL quote doubling applied to Cypher, where `''`
  is an empty string and escapes nothing — existed in three identical copies and was used at 17
  interpolating call sites. The sweep's repro was a model-authored node id that ended the
  surrounding string literal and dropped the graph. The fix is the shape, not the call sites:

  - `MemoryGraphApi.query(cypher, params)` is **replaced by `run(query: GraphQuery)`**, where
    `GraphQuery` is `{cypher, params}` and `GraphQueryRunner` is the one-method interface
    (`@maf/types`). The driver prepares `cypher` and passes `params` to the binder, so a value is
    compared as data. That also silently repaired six packages that were already *calling* the old
    method with `$name` parameters — the parameters were being dropped (the real
    `Connection.query` takes one argument), so each of those call sites was interpolating.
  - `MemoryGraphApi` extends `GraphQueryRunner`; `SubgraphQuery`, `RunMerger`,
    `FailurePatternDetector`, `RetrievalAugmentedPlanner`, `CypherEvaluator`, `PolicyEngine` and
    the CLI's lesson graph now take the interface rather than the concrete class.
  - `KuzuDriver` exposes only `run(query)`. There is deliberately no method taking a statement on
    its own, so a caller cannot reintroduce the substitution.
  - The two positions Cypher cannot bind — `LIMIT` (Kùzu rejects `LIMIT $n`) and a
    variable-length path's hop count — go through `intLiteral(value, what)`, exported from
    `@maf/memory-graph`, which **throws** rather than coercing. An id list becomes one generated
    parameter per element (`$nid0, $nid1, …`) because Kùzu rejects an array parameter.

- **`NodeId` is validated at construction** (`makeNodeId`). It was a bare cast applied straight to
  planner JSON; it is now 1–128 characters of `A-Za-z0-9_-`. Real binding is what makes a crafted
  id harmless in a query; this is the second half — an id is also safe as a map key, a transcript
  label or a filename stem.

- **`PolicyDecision` is three-valued: `Indeterminate` joins `Allow`/`Deny`/`Escalate`**, and a
  policy rule whose graph query fails now **refuses** the call instead of being skipped.
  `evaluateCypher` did `catch { return false }`, so any graph error silently stopped every
  `memoryPattern` Deny rule from firing — and breaking the graph is the easiest thing for the
  party the rule is aimed against to arrange. The refusal names the rule and the underlying
  error. A rule whose template names a parameter that cannot be bound (a typo like `$filePath`)
  is likewise `Indeterminate`, not a rule that never matches. `Refusal` is the narrowed
  `Deny | Escalate | Indeterminate`; `PolicyViolationError` carries it, `ViolationHandler` treats
  only `Escalate` as escalatable and gained `isIndeterminate`, and `executeToolGated` refuses on
  it.

### Fixed

- Tool inputs are deep-frozen by `executeToolGated` before policy evaluation, so the input the
  policy judged is the input the tool runs on. A tool that rewrote its own input inside `execute`
  threw a `TypeError` instead of choosing its paths after the gate had closed.

- `@maf/memory-graph` has tests and a `test` script. The binding guarantee is asserted against a
  **real** Kùzu database (a crafted value round-trips byte-for-byte and the graph is untouched,
  while the same text spliced into the query deletes a row — the anti-vacuity half), and a source
  guard fails if the quote-doubling escaper or a `$name`-substituting `replace` reappears anywhere
  under a package's `src`. Both halves were verified to fail when the defect is put back.

- `run()` **propagates** a query error rather than returning an empty result. The best-effort
  readers that legitimately tolerate a graph failure (`ScoreRecorder`, the planner's lesson
  recall, `maf knowledge sync`, `querySubgraph`'s edge lookup) now say so in an explicit
  `try`/`catch` at the point where the tolerance is intended.
