# WP-3.9 — hardening

Branch: `wp/3.9-hardening` → `wp/phase-3b`

## What this changes

Boundaries that were documented or implied but not enforced: what environment a child gets, what a
patch declares, what a test runner may be told, what a configuration file may name, what the
evolver may widen, what a past failure may carry into a prompt, and whether the backend can take
the argv MAF builds for it. Each is enforced in the code that acts on it, and `docs/SECURITY.md`
states each as implemented.

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
- A rejected hunk leaves **nothing** beside the target: `--no-backup-if-mismatch` stops the `.orig`
  backup, and the rejects go to a named `0600` `--reject-file=<path>` in the temp dir that is read
  into `stdout` and unlinked. Not `--reject-file=-`, which GNU `patch` reads as *discard the
  rejects* and Apple's patch as *write them to stdout* — one argv, two behaviours, and the CI run on
  Linux caught the difference the macOS test suite could not.
- **Proof.** `packages/tools/src/__tests__/patch.test.ts` covers strip 0 and a strip deeper than
  the path, the `.orig`/`.rej` siblings through `declaredPaths`, the `.git` refusal, and a real
  execution against a fake `patch` on `PATH` that records the mode of the file it was handed
  (`600`) and whose path is gone after the call — plus, for the reject file, that it is named, lives
  outside the project and is gone when the call returns.

### `test.run` bounds what a model may ask it to run

- **`packages/tools/src/plugins/test-runner.ts`** — the runner is checked against the fixed enum at
  the point the argv is built, so bypassing schema validation cannot fall through to a runner the
  caller did not choose; a filter beginning with `-` is refused, and positional filters (`bun`,
  `cargo`) follow `--`; `timeout` defaults to 120 s and is clamped to `MAX_TEST_TIMEOUT_MS`
  (fifteen minutes).
- The child is spawned `detached` on POSIX, so it leads its own group, and the group is killed on
  **every exit MAF observes** (F9): timeout, normal `close`, and MAF's own `exit` / `SIGINT` /
  `SIGTERM`, where a process-level hook reaps every group in flight and then re-raises the signal
  at MAF. The timeout used to be the only path that killed the group, so a runner that exited 0
  left its workers and servers behind, and an interrupted MAF left the runner running (Windows has
  no process group and signals the direct child).
- **Proof.** `packages/tools/src/__tests__/test-runner.test.ts` runs a real `node --test` child that
  asserts `MAF_SIGNING_KEY` and `MAF_RUNTIME_STATE` are absent while `PATH` is present; refuses a
  `-` filter and an unknown runner by name; pins each runner's argv; clamps an oversized timeout;
  proves a grandchild written by a timed-out run stops answering `kill(pid, 0)`; proves the same
  grandchild dies when the runner **exits 0**; and spawns a real parent that runs the tool, sends it
  `SIGINT`, and asserts the parent dies **by that signal** and the grandchild dies with it.

### A past failure cannot carry a secret into a prompt

- **`packages/dag-runner/src/DagRunner.ts`** — `failureRecord` applies `redactText` to the label,
  the task description, the run title and the error message before the record reaches
  `MemoryGraph.recordFailure` (F4). The memory graph outlives the run, and its records are
  rendered into a later planner's `<past-failures>` block, which is part of a model's system
  prompt — so a key pasted into a task description or quoted in an error message was replayed to
  a model on a later run. The broad set, not credentials only: this is model-facing recall, not
  the evidence bundle, which stays byte-faithful.
- **`packages/planning-agent/src/RetrievalAugmentedPlanner.ts`** and
  **`packages/planning-agent/src/FailurePatternDetector.ts`** — redacted again where memory is read
  back into a prompt. The write-side boundary cannot help records written before it existed, so
  the read side does not trust the graph either.
- **Proof.** `packages/dag-runner/src/__tests__/failure-recorder.test.ts` drives the scheduler with
  a capturing recorder and plants a key format and a `password = …` assignment in the task, the
  label, the run title and the error; `packages/planning-agent/src/__tests__/failure-recall.test.ts`
  writes a pre-fix record straight to a real Kùzu graph and reads it back through both renderers.
  Each boundary was confirmed to fail when its `redactText` is removed.

### The config file is a closed schema

- **`packages/policy-engine/src/PolicyLoader.ts`** — `parseYamlDocument` refuses `__proto__`,
  `constructor` and `prototype` as keys **at any depth** (F10), at the line the key is on. This is
  the one parse every `.maf/` file goes through — `config.yaml`, `policy.yaml` and `roles.yaml` —
  so the refusal is the parser's, not each loader's to remember. The YAML document is converted
  with own keys, so the loaded value was never itself poisoned; the danger is the next reader that
  copies it with a plain assignment.
- **`packages/dag-runner/src/DagParser.ts`** — a workflow spec read as JSON never reaches
  `parseYamlDocument`, so `fromYamlText` repeats the refusal in a `JSON.parse` reviver. A key
  refused this way throws a message naming the key; it is not reported as "could not parse JSON",
  which would hide the reason.
- **`packages/cli/src/config/ConfigLoader.ts`** already refused unknown keys with their line number
  and read every key with `Object.hasOwn`. Its own check still runs, but a prototype key is now
  refused one layer earlier by `parseYamlDocument`; the regression in
  `packages/cli/src/__tests__/ConfigLoader.test.ts` pins the new message and still asserts no
  polluted key appears on `{}`.
- **Proof.** `packages/policy-engine/src/__tests__/parseYamlDocument.test.ts` covers the three
  names at the document, nested, in a flow mapping and inside a list;
  `packages/dag-runner/src/__tests__/spec-keys.test.ts` covers them in the document, a node and
  `config`, and proves the same words as **values** (`label: 'constructor'`) still parse;
  `packages/roles/src/__tests__/roles-file-loading.test.ts` covers the block, JSON and nested
  forms.

### The backend is asked once whether it can take the argv MAF builds

- **`packages/types/src/index.ts`** — `CliAdapter.preflight?()`, an optional member (F5). Only a
  backend whose argv depends on flags MAF must find has anything to check; an adapter written
  before this still satisfies the interface unchanged.
- **`packages/adapters/claude/src/ClaudeAdapter.ts`** — every governed turn and both isolated
  cli-tier sets pass `--tools`. A `claude` that does not know the flag exits 1 on every node, so a
  stale or patched CLI read as a plan full of identical failures. `preflight()` resolves `claude` on
  PATH itself (every directory in order, `PATHEXT` on Windows), asks the resolved binary
  `--version` then `--help` — both with `backendEnv()`, both bounded at 10 s — and refuses unless
  `--help` lists `--tools`. A failure names the resolved path and the version found, so a stale
  binary is distinguishable from a missing one.
- **`packages/cli/src/commands/run.ts`** (lines 158–163) — `maf run` calls it exactly once, after
  the adapter is resolved and before anything is planned: before a worktree, a store or a plan
  exists.
- **Proof.** `packages/adapters/claude/src/__tests__/preflight.test.ts` puts a stand-in `claude` on
  PATH and proves the returned path is the binary rather than the bare name, that both questions
  were asked, and that a `--help` without `--tools` is refused naming path and version; a third
  case runs with an empty PATH. `packages/cli/src/__tests__/preflight-wiring.test.ts` drives a fake
  adapter through `maf run` and proves the call happens once with zero adapter calls behind it.

### The evolver cannot widen a role into a writer

- **`packages/evolver/src/gate.ts`** — stage `b4-write-tool-widening`, after the safety-adjacent
  routing at b3, exported as `gateWidening` so the loop can ask it before spending. The widening is
  the candidate role's allowlist minus the current one, and it is judged by each tool's registry
  `permissionLevel`: a `write`, `execute` or `dangerous` tool returns `needs-approval` (F8 — the
  operator may grant it; a candidate never ships itself), naming the tools and the role. Adding only
  `read` tools is not a widening, and a tool the role already holds is not something the edit
  granted. `GateContext.toolPermissions` is required (F7) and a tool the map does not name is
  treated as `dangerous`: an omitted map used to skip the rule silently.
- **`packages/evolver/src/loop.ts`** — `EvolveOptions.toolPermissions` is required and threaded into
  the gate. The widening check runs after `applyEdit` and **before** the smoke test and the golden
  suite, so a widening manifest spends nothing.
- **`packages/cli/src/commands/evolve.ts`** — passes the permission level of every tool in
  `createDefaultRegistry()`, so the gate judges tools by what they do rather than by their names.
- **Proof.** `packages/evolver/src/__tests__/evolver.test.ts`: one case per level — `fs.write` and
  `fs.delete` (write), `test.run` and `shell.exec` (execute), `deploy.prod` (dangerous) — each
  returning `needs-approval` with the tool named; a tool the role already holds, or one an `add`
  grants after a `remove`, is judged as candidate-minus-current; an unclassified tool is not assumed
  harmless; the map is a required property (a `@ts-expect-error` call shape); the same edit on a
  safety-adjacent role returns `needs-approval` at b3; adding a read tool still ships; and a loop
  case proves a widening manifest runs neither the smoke test nor the golden suite.

## Decisions

**D-59 · A candidate that widens a role with a write tool is the operator's decision, not the
evolver's refusal.** Stage `b4-write-tool-widening` answered `reject`: a candidate that added a
`write`, `execute` or `dangerous` tool to an ordinary role ended there, after the golden suite had
already been run. The verdict is now `needs-approval`, the gate outcome that names a decision a
human may make. Nothing else about the rule changes: the widening is still judged by each tool's
registry `permissionLevel`, still taken as the candidate's surface minus the current one, and a
candidate still cannot ship itself — `maf evolve` records `needs-approval` with the tools and the
role, and moves on without a smoke test or a golden run. No flag grants this particular approval:
`--approve-sensitive` covers b3's safety-adjacent routing, and the widening rule runs whether or
not it is set. What changed is who answers the question. WP-3.7's live row holds on this verdict —
the row is the end-to-end check on what an operator is offered, and it is why this ruling is
recorded rather than left as an internal detail.

**Rejected — keep `reject` and re-scope WP-3.7's live row.** A rejection does not guard the
decision, it removes it: a role is permanently denied a tool its operator may well have wanted,
and the answer arrives only after a candidate has been paid for. §6.3 already treats a change to
what an agent may do as the operator's call everywhere else — a prompt edit on a safety-adjacent
role (b3), a sensitive manifest (`--approve-sensitive`) — so rejecting a widening would be the one
place where the gate answers a question that was the operator's, and the live row that exists to
check exactly that would have to be rewritten to describe the weaker behaviour.

## Files outside the spec's list, and why

The spec (`docs/BUILD_PLAN.md`, WP-3.9) lists `ProcessSpawner.ts`,
`packages/tools/src/plugins/{patch,test-runner,grep}.ts`, the config loaders,
`packages/evolver/src/gate.ts` and `docs/SECURITY.md`. This branch also changes:

| File | Why |
|---|---|
| `packages/types/src/childEnv.ts` (new) | The two environment policies need one home both `@maf/adapter-base` and `@maf/tools` already depend on. |
| `packages/types/src/index.ts` | Three additive changes, each marked `// WP-3.9`: the `childEnv` re-export, `ToolDeclarationError`, and the optional `CliAdapter.preflight?()`. Nothing existing changed shape. |
| `packages/adapters/{claude,codex,gemini}/src/*Adapter.ts` | Every spawn and every `--version` probe passes `backendEnv()`. |
| `packages/adapters/claude/src/index.ts` | Re-exports the `ClaudePreflight` result type. |
| `packages/cli/src/commands/{run,inprocessDemo}.ts` | `run` calls the one preflight; the demo's fixture `npm test` is agent-touched code and gets `toolEnv()`. |
| `packages/eval-harness/src/verifiers.ts` | A `test-script` verifier runs a script the coder's work dir authored: `toolEnv()`, not maf's environment. |
| `packages/git-ops/src/SnapshotDiff.ts` | `runIsolatedGit` is a tool child: git's environment is built from `toolEnv()`, not `process.env`. |
| `packages/tools/src/plugins/git.ts` | The same boundary for the agent's `git.*` tools. |
| `packages/tool-loop/src/gatedExec.ts` | A tool that cannot declare its paths (`ToolDeclarationError`) is refused under `builtin:declaration` rather than run unjudged. |
| `packages/policy-engine/src/PolicyLoader.ts` | `parseYamlDocument` refuses the three prototype key names at any depth — every `.maf/` file's one parse. |
| `packages/dag-runner/src/DagParser.ts` | A JSON workflow spec gets the same refusal through a `JSON.parse` reviver. |
| `packages/dag-runner/src/DagRunner.ts` | `failureRecord` redacts before the record reaches the memory graph. |
| `packages/planning-agent/src/{RetrievalAugmentedPlanner,FailurePatternDetector}.ts` | Both `<past-failures>` renderers redact again on the way into a prompt. |
| `packages/evolver/src/{gate,loop,index}.ts` | The widening rule (exported as `gateWidening`), the required permission map, and the pre-spend check. |
| `packages/cli/src/commands/evolve.ts` | Supplies each tool's `permissionLevel` from `createDefaultRegistry()`. |
| Tests | `packages/adapters/base/src/__tests__/ProcessSpawner.test.ts`, `packages/adapters/{claude,codex,gemini}/src/__tests__/{backend-env,preflight}.test.ts`, `packages/types/src/__tests__/childEnv.test.ts`, `packages/tools/src/__tests__/{patch,test-runner,git-args,grep-args,worktree-confinement,input-schema}.test.ts`, `packages/git-ops/src/__tests__/SnapshotDiff.test.ts`, `packages/eval-harness/src/__tests__/verifier-env.test.ts`, `packages/cli/src/__tests__/{preflight-wiring,fixture-tests-env,ConfigLoader,approval-gate-stack}.test.ts`, `packages/policy-engine/src/__tests__/parseYamlDocument.test.ts`, `packages/dag-runner/src/__tests__/{spec-keys,failure-recorder}.test.ts`, `packages/roles/src/__tests__/roles-file-loading.test.ts`, `packages/planning-agent/src/__tests__/failure-recall.test.ts`, `packages/tool-loop/src/__tests__/declaredPaths.test.ts`, `packages/evolver/src/__tests__/evolver.test.ts`. |
| `docs/SECURITY.md` | States each boundary as implemented, including the three limits on the group kill. |
| `docs/changes/WP-3.9.md` | This fragment. |

The spec's "config loaders" item is discharged in `parseYamlDocument` (the loader every config,
policy and roles file goes through) rather than in `ConfigLoader.ts`; that is recorded above rather
than claimed as a change to the loader.

### Overlap with WP-3.2 (#52)

Measured against `wp/3.2-lcm` at `ae45750` with `git merge-tree`: eight files are changed by both
branches — `packages/cli/src/__tests__/approval-gate-stack.test.ts`,
`packages/cli/src/__tests__/ConfigLoader.test.ts`, `packages/cli/src/commands/{evolve,run,inprocessDemo}.ts`,
`packages/git-ops/src/SnapshotDiff.ts`, `packages/tools/src/__tests__/input-schema.test.ts` and
`packages/types/src/index.ts`. Seven auto-merge. The one conflict is
`approval-gate-stack.test.ts`, and it is comment-only: both branches added a comment above the same
`const mafDir` line (this branch saying the directory is created here; WP-3.2 saying the stores do
not create it). Keeping either comment resolves it; the rest of what either side adds there —
including the `mkdir` call and its import — is identical.

### The `claude` preflight check

It **is** in this branch — see the section above. An earlier draft of this fragment said it was
not: at that point the branch only gave `ClaudeAdapter.isAvailable()` a `backendEnv()`, and the
flag-support check was added afterwards.

## Verification

- `pnpm -r build` and `pnpm -r typecheck` clean, and `grep "error TS"` over the build output = 0.
- Every package suite: `pnpm -r test` — **1191 tests, 1190 passed, 1 skipped, 0 failed**, measured
  at `5e17601` (the last commit on this branch that changes code; the commits after it are this
  fragment and `docs/SECURITY.md`).
- The four repository guards: `check:build-output`, `check:test-scripts`, `check:workspace-deps`,
  `check:doc-refs`.

## Recorded limits

- Group kill reaches a process group, not a descendant tree. A child that leaves the group
  (`setsid()` / `setpgid()`) is not reached by `-pid`; a Windows child tree is not reached either,
  since only the runner is signalled; and a `SIGKILL` to MAF runs no handler, so the groups it
  started survive it. `docs/SECURITY.md` states all three rather than implying a guarantee.
- On Windows there are no POSIX process groups; `test.run` signals the runner alone, and the
  section in `docs/SECURITY.md` says so.
- `patch.apply` is still confined by the policy engine only (the tool does not re-resolve the paths
  it declares), and a direct call that skips the policy layer gets no confinement. `docs/SECURITY.md`
  already states this; the declaration above is what lets a path rule see the files at all.
- `--approve-sensitive` changes only whether an edit targeting a safety-adjacent role is evaluated;
  `maf evolve` has no interactive approval and does not ship such a candidate. `docs/SECURITY.md`
  states this rather than implying a path that would ship one.
- A `needs-approval` from the widening rule has no flag that grants it: `maf evolve` records the
  tools and the role and stops. The operator grants a widening by authoring it; there is no
  `--approve-widening`, and this branch does not add one.
- `preflight` is asked once, by `maf run`, before anything is planned; `goldens` and `evolve` do not
  ask it. It proves `claude --help` lists `--tools`; a binary that lists the flag and rejects it at
  run time still fails at the first node — one sentence later than before.
- The prototype-key refusal covers keys a **file** names. `DagParser.fromSpec` takes an
  already-built object from a programmatic caller and parses no text; that caller is trusted by
  construction.
- Redaction at the memory boundaries is pattern-based, on the broad `redactText` set rather than
  credentials-only, applied on write and again on read-back. A secret in a format no pattern
  recognises is masked by neither.
