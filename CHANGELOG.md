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

### Fixed

- Tool inputs are deep-frozen by `executeToolGated` before policy evaluation, so the input the
  policy judged is the input the tool runs on. A tool that rewrote its own input inside `execute`
  threw a `TypeError` instead of choosing its paths after the gate had closed.
