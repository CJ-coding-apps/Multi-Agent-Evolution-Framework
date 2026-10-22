# WP-3.9 — hardening

Branch: `wp/3.9-hardening` → `wp/phase-3b`

## What this changes

Six boundaries that were documented or implied but not enforced: what environment a child gets,
what a patch declares, what a test runner may be told, what a config file may name, and what the
evolver may widen. Each is enforced in the code that acts on it, and `docs/SECURITY.md` states each
as implemented.

### A child process does not inherit MAF's own variables

- **`packages/types/src/childEnv.ts`** (new) — two policies, both pure functions of a base map so
  they can be tested without a run. `TOOL_ENV_ALLOWLIST` / `toolEnv()` is the short list a tool
  child may see: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TMPDIR`/`TMP`/`TEMP`, `LANG`,
  `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `NODE_EXTRA_CA_CERTS` and the Windows profile variables. It
  carries no `MAF_*`, no provider token, and not `NODE_OPTIONS`, `GIT_*` or `SSH_AUTH_SOCK`.
  `backendEnv()` is the other policy: the whole environment minus every `MAF_*` variable, so a
  backend CLI still receives the provider credentials it needs to authenticate and never the
  signing key or the run-state paths.
- **`packages/adapters/base/src/ProcessSpawner.ts`** — both `spawnAndCollect` and `spawnStreaming`
  default to `backendEnv()`; an explicit `env` is the caller's and is not augmented.
- **`packages/adapters/{claude,codex,gemini}/src/*Adapter.ts`** — every spawn and every `--version`
  probe passes a `backendEnv()`-derived environment.
- **`packages/tools/src/plugins/{grep,git,patch,test-runner}.ts`** and
  **`packages/git-ops/src/SnapshotDiff.ts`** — every tool child uses `toolEnv()`.
- **Proof a child cannot see the key.** `packages/types/src/__tests__/childEnv.test.ts` spawns a
  real `node` child and asserts `MAF_SIGNING_KEY` is absent (printing `ABSENT`), and
  `packages/adapters/base/src/__tests__/ProcessSpawner.test.ts` does the same through both
  spawner functions, with a provider key still present where the backend policy keeps it.

### `patch.apply` declares what `patch` will open

- **`packages/tools/src/plugins/patch.ts`** — `declaredPaths` is a pure function of the diff and the
  chosen `strip`: `extractDiffPaths` strips exactly the components passed to `patch -p`, reads both
  `+++`/`---` and `diff --git` headers, skips `/dev/null` and an empty result, and
  `patchWritePaths` adds each target's `.orig` and `.rej` sibling. A diff that touches `.git` is
  refused before policy, resolved siblings included.
- The temp diff is written `{ mode: 0o600, flag: 'wx' }` and removed in `finally`; `wx` fails
  rather than following a symlink planted at that path.
- **Proof.** `packages/tools/src/__tests__/patch.test.ts` covers strip 0 and a strip deeper than
  the path, the `.orig`/`.rej` siblings through `declaredPaths`, the `.git` refusal, and a real
  execution against a fake `patch` on `PATH` that records the mode of the file it was handed
  (`600`) and whose path is gone after the call.

### `test.run` bounds what a model may ask it to run

- **`packages/tools/src/plugins/test-runner.ts`** — the runner is checked against the fixed enum at
  the point the argv is built, so bypassing schema validation cannot fall through to a runner the
  caller did not choose; a filter beginning with `-` is refused, and positional filters (`bun`,
  `cargo`) follow `--`; `timeout` defaults to 120 s and is clamped to `MAX_TEST_TIMEOUT_MS`
  (fifteen minutes); the child is spawned `detached` on POSIX and `SIGKILL` is sent to `-pid`, so
  its own children die with it (Windows has no process group and signals the direct child).
- **Proof.** `packages/tools/src/__tests__/test-runner.test.ts` runs a real `node --test` child that
  asserts `MAF_SIGNING_KEY` and `MAF_RUNTIME_STATE` are absent while `PATH` is present; refuses a
  `-` filter and an unknown runner by name; pins each runner's argv; clamps an oversized timeout;
  and proves a grandchild written by a timed-out run stops answering `kill(pid, 0)` within two
  seconds of the 124 answer.

### The config file is a closed schema

- **`packages/cli/src/config/ConfigLoader.ts`** already refused unknown keys with their line number
  and read every key with `Object.hasOwn`; `__proto__` and `constructor` are unknown in every
  section. No production change was needed; the existing test
  (`packages/cli/src/__tests__/ConfigLoader.test.ts`) pins four spellings, including
  `constructor.prototype`, and asserts no polluted key appears on `{}`.

### The evolver cannot widen a role into a writer

- **`packages/evolver/src/gate.ts`** — stage `b4-write-tool-widening`, after the safety-adjacent
  routing at b3: an `adjust_tool_allowlist` edit that adds a tool whose registry
  `permissionLevel` is `write`, `execute` or `dangerous` to an ordinary role is rejected, naming the
  tools and the role. Adding only `read` tools is not a widening. An edit targeting a
  safety-adjacent role was already routed to the operator at b3 and is recorded as
  `needs-approval`, never shipped by the loop.
- **`packages/evolver/src/loop.ts`** — `EvolveOptions.toolPermissions` is threaded into the gate.
- **`packages/cli/src/commands/evolve.ts`** — passes the permission level of every tool in
  `createDefaultRegistry()`, so the gate judges tools by what they do rather than by their names.
- **Proof.** `packages/evolver/src/__tests__/evolver.test.ts` adds three cases: a write tool added
  to an ordinary role is rejected at `b4-write-tool-widening` with the tool named; the same edit
  targeting a safety-adjacent role returns `needs-approval` at b3; adding a read tool still ships.

## Files outside the spec's list, and why

The spec (`docs/BUILD_PLAN.md`, WP-3.9) lists `ProcessSpawner.ts`,
`packages/tools/src/plugins/{patch,test-runner,grep}.ts`, the config loaders,
`packages/evolver/src/gate.ts` and `docs/SECURITY.md`. This branch also changes:

| File | Why |
|---|---|
| `packages/types/src/childEnv.ts` (new), `packages/types/src/index.ts` | The two environment policies need one home both `@maf/adapter-base` and `@maf/tools` already depend on; `index.ts` re-exports them. |
| `packages/adapters/{claude,codex,gemini}/src/*Adapter.ts` | Every spawn and every `--version` probe passes `backendEnv()`. |
| `packages/git-ops/src/SnapshotDiff.ts` | `runIsolatedGit` is a tool child: git's environment is built from `toolEnv()`, not `process.env`. |
| `packages/tools/src/plugins/git.ts` | The same boundary for the agent's `git.*` tools. |
| `packages/evolver/src/loop.ts` | Threads `EvolveOptions.toolPermissions` into the gate. |
| `packages/cli/src/commands/evolve.ts` | Supplies `toolPermissions` from `createDefaultRegistry()`. |
| `packages/adapters/base/src/__tests__/ProcessSpawner.test.ts`, `packages/types/src/__tests__/childEnv.test.ts`, `packages/tools/src/__tests__/{patch,test-runner,git-args,worktree-confinement}.test.ts`, `packages/evolver/src/__tests__/evolver.test.ts` | Proof for the changes above. |
| `docs/changes/WP-3.9.md` | This fragment. |

The spec's "config loaders" item needed no production change; that is recorded above rather than
claimed as a change.

### Overlap with WP-3.2 (#52)

Three files are also changed by `wp/3.2-lcm`: `packages/cli/src/commands/evolve.ts`,
`packages/git-ops/src/SnapshotDiff.ts` and `packages/types/src/index.ts`. The hunks are disjoint —
WP-3.2 adds LCM plumbing, this branch adds `toolPermissions`, `toolEnv()` and a re-export — but
whichever of #52/#53 merges second resolves two textual conflicts by keeping both sides.

### The `claude` preflight check

It is **not** in this branch. The only `claude` probe it touches is the existing
`ClaudeAdapter.isAvailable()` (`claude --version`), and only to give it `backendEnv()`; no
flag-support or version gate is added. On this branch "preflight" appears only in two unrelated
test comments (`init.test.ts`, `run-settings.test.ts`).

## Verification

- `pnpm -r build` and `pnpm -r typecheck` clean.
- Package suites: types, tools, adapters/base, evolver, the three adapters, git-ops.
- The four repository guards: `check:build-output`, `check:test-scripts`, `check:workspace-deps`,
  `check:doc-refs`.

## Recorded limits

- On Windows there are no POSIX process groups; `test.run` signals the runner alone, and the
  section in `docs/SECURITY.md` says so.
- `patch.apply` is still confined by the policy engine only (the tool does not re-resolve the paths
  it declares), and a direct call that skips the policy layer gets no confinement. `docs/SECURITY.md`
  already states this; the declaration above is what lets a path rule see the files at all.
- `--approve-sensitive` changes only whether an edit targeting a safety-adjacent role is evaluated;
  `maf evolve` has no interactive approval and does not ship such a candidate. `docs/SECURITY.md`
  states this rather than implying a path that would ship one.
