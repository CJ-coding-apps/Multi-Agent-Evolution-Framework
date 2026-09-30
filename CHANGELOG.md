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

### Fixed

- Tool inputs are deep-frozen by `executeToolGated` before policy evaluation, so the input the
  policy judged is the input the tool runs on. A tool that rewrote its own input inside `execute`
  threw a `TypeError` instead of choosing its paths after the gate had closed.
