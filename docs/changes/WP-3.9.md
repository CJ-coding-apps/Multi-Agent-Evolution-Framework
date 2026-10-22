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
- **Every adapter spawn site, proved at the child (round 2, G6).** The adapter half had one test
  per backend, and it drove `invoke` only — the cli tier. `sendTurn`, the path every governed role
  takes, and each `--version`/`--help` probe had no test of the environment they spawn with. A
  stand-in `claude`/`codex` earlier on PATH now appends the environment it was actually given, and
  `packages/adapters/{claude,codex}/src/__tests__/backend-env.test.ts` drives `invoke`, `sendTurn`
  and the `isAvailable` `--version` question through it, while
  `packages/adapters/claude/src/__tests__/preflight.test.ts` drives both preflight probes. Each
  test asserts no `MAF_*` name arrived and that `PATH`, `HOME` and the provider key did — so
  "empty environment" cannot pass as the policy. Measured: six reverted spawn sites (claude
  `sendTurn`, claude `isAvailable`, claude `preflight`, codex `sendTurn`, codex `isAvailable`,
  the spawner's default) each failed exactly the one test that names it, and nothing else.

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
- The call is answered on the runner's **`exit`**, not only on `close` (G16b). `close` waits for the
  child to exit *and* its stdio to close, and a passing suite that leaves a helper holding the
  inherited stdout never reaches the second half — so the call was answered by the timeout: 124 and
  a `[TIMEOUT]` line for a run that had finished. `exit` kills the group (which is what closes that
  pipe), then gives `close` `CLOSE_GRACE_MS` (100 ms) before answering with the runner's **own**
  exit code; whichever event arrives first answers, once. The grace is the time the kernel needs to
  deliver the follow-up event, not a second budget for the suite.
- **Proof.** `packages/tools/src/__tests__/test-runner.test.ts` runs a real `node --test` child that
  asserts `MAF_SIGNING_KEY` and `MAF_RUNTIME_STATE` are absent while `PATH` is present; refuses a
  `-` filter and an unknown runner by name; pins each runner's argv; clamps an oversized timeout;
  proves a grandchild written by a timed-out run stops answering `kill(pid, 0)`; proves the same
  grandchild dies when the runner **exits 0**; and spawns a real parent that runs the tool, sends it
  `SIGINT`, and asserts the parent dies **by that signal** and the grandchild dies with it.
- **Proof, round 2.** The same parent is now sent `SIGTERM` (dies by it, grandchild reaped) and is
  made to **exit 0** while the runner is live (parent reports `{code: 0, signal: null}`, grandchild
  reaped) — G10, the two exits the F9 change had a hook for but no test. And a real `npm test` suite
  that **passes** and leaves a helper spawned with `stdio: 'inherit'` is answered `exitCode === 0`
  with no `[TIMEOUT` in stderr, and the helper is reaped (G16b). Measured mutants, each killing
  exactly the named test and nothing else: delete the `exit` handler → 13/14, failing only G16b
  (the run answers 124 after the full 8 s budget for a 0.4 s suite); give `process.on('exit')` an
  empty body → 13/14, failing only the normal-exit test; drop `'SIGTERM'` from the hook's signal
  list → 13/14, failing only the SIGTERM test (on the reaping assertion: without a listener Node's
  default action still ends the parent by SIGTERM, so the survivor is the observable).
- **Proof of the allowlist test itself (round 2, G14).** The env child now **records what it
  observed** to `env.json` and the test asserts on that file, and `NODE_TEST_*` is removed from the
  parent for the call's duration. An inherited `NODE_TEST_CONTEXT` puts the inner `--test` in child
  mode, where a **failing assertion still exits 0**, so a spawner that passed the whole parent
  environment through kept this test green. Measured on `env: process.env`: 8/14, with this test
  first in the failure list and the process-group tests dying incidentally. The observation is
  written before the in-child assertions, so the verdict does not depend on how a runner reports a
  failure; the other `runner: 'node'` stand-ins were checked and have no assertion inside the child,
  so the trap does not apply to them.

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
  before this still satisfies the interface unchanged. It may return a `PreflightReport`
  (`{path, version}`, G15) so a caller can name what was checked without parsing a message; an
  adapter with nothing to report returns nothing.
- **`packages/adapters/claude/src/ClaudeAdapter.ts`** — every governed turn and both isolated
  cli-tier sets pass `--tools`. A `claude` that does not know the flag exits 1 on every node, so a
  stale or patched CLI read as a plan full of identical failures. `preflight()` resolves `claude` on
  PATH itself (every directory in order, `PATHEXT` on Windows), asks the resolved binary
  `--version` then `--help` — both with `backendEnv()`, both bounded at 10 s — and refuses unless
  `--help` lists `--tools`. A failure names the resolved path and the version found, so a stale
  binary is distinguishable from a missing one.
- **`packages/cli/src/commands/run.ts`** (lines 155–176) — `maf run` looks the adapter up by name
  (`lookupAdapter`, a refusal that names only an unknown adapter), calls preflight exactly once, and
  then plans: before a worktree, a store or a plan exists. Preflight runs *instead of* the
  availability check for an adapter that has one (G15) — a passing preflight has already proved the
  binary runs and takes the argv, which is what `isAvailable` was asking — and an adapter without a
  preflight still gets `resolveAdapter`. A report is said as
  `[maf] preflight: claude <path> (<version>)`.
- **Proof.** `packages/adapters/claude/src/__tests__/preflight.test.ts` puts a stand-in `claude` on
  PATH and proves the returned path is the binary rather than the bare name, that both questions
  were asked, and that a `--help` without `--tools` is refused naming path and version; a third
  case runs with an empty PATH. Both stand-in probes are also proved to receive `backendEnv()`
  (round 2, G6). `packages/cli/src/__tests__/preflight-wiring.test.ts` drives a fake adapter
  through `maf run` and proves the call happens once with zero adapter calls behind it.
- **Proof the refusal stops the run (round 2, G7).** A second test in the same file runs the
  **real** `ClaudeAdapter` — not a stub whose `preflight()` throws — against a stand-in `claude`
  on PATH whose `--help` has no `--tools`, through `driveRun`, which is the wiring `main.ts`
  registers. It asserts three separate facts: the throw carries the preflight sentence naming the
  binary and version (which `main.ts` turns into `[maf] error: …` and exit 1); the stand-in was
  asked exactly `--version`, `--help` — the two probes, with no separate availability check ahead
  of them (G15) — so a planner call (`--print …`) was never made; and `.maf/harnesses` and
  `.maf/worktrees` do not exist, so no store was opened. Measured: swallowing the refusal
  (`await preflight().catch(() => {})`) fails this test, and moving the call to after the harness
  is resolved fails it on the never-opened-store assertion.
- **Proof of the two G15 halves.** (a) The same file's first test now returns
  `{path: '/opt/maf/bin/claude', version: '9.9.9 (stand-in)'}` from the fake and asserts the run
  said `[maf] preflight: claude /opt/maf/bin/claude (9.9.9 (stand-in))`. (b) A third test runs the
  real `ClaudeAdapter` with `PATH` set to one empty directory and asserts the refusal is
  `no executable named "claude" was found on PATH (1 directory searched)` — not the generic
  `Adapter "claude" is not available on this system`, which named neither binary nor PATH and used
  to answer first. Measured for (a): dropping the `say` (keeping the preflight call, `void
  preflight`) fails test 1 and leaves the other two green. Measured for (b): putting
  `resolveAdapter` back in front fails **both** the G7 test (the sequence becomes `--version`,
  `--version`, `--help`) and the missing-binary test.

### The evolver cannot widen a role into a writer

- **`packages/evolver/src/gate.ts`** — stage `b4-write-tool-widening`, after the safety-adjacent
  routing at b3, exported as `gateWidening`. The widening is the candidate role's allowlist minus
  the current one, and it is judged by each tool's registry `permissionLevel`: a `write`, `execute`
  or `dangerous` tool returns `needs-approval` (F8 — the operator may grant it; a candidate never
  ships itself), naming the tools and the role. Adding only `read` tools is not a widening, and a
  tool the role already holds is not something the edit granted. `GateContext.toolPermissions` is
  required (F7) and a tool the map does not name is treated as `dangerous`: an omitted map used to
  skip the rule silently. The free stages — the invariants at b, screening at b2, routing at b3 and
  the widening at b4 — are exported together as `gateStatic` (G3/G4), with the invariant stage
  first: an unknown tool id is a malformed candidate, so it is refused (`reject`, naming the tools
  the registry does know) before the widening rule can treat it as `dangerous` and ask the operator
  to approve a tool that does not exist.
- **`packages/evolver/src/loop.ts`** — `EvolveOptions.toolPermissions` is required and threaded into
  the gate. `gateStatic` runs after `applyEdit`, **the moment the candidate manifest exists**: before
  the critic call, the smoke test and the golden suite, so a manifest that widens a role or names an
  unknown tool costs the proposal and nothing else. The check runs again on the final manifest,
  because a critic revision can introduce either defect; the critic's own calls are the only model
  calls between the two checks.
- **`packages/cli/src/commands/evolve.ts`** — passes the permission level of every tool in
  `createDefaultRegistry()`, so the gate judges tools by what they do rather than by their names.
- **Proof.** `packages/evolver/src/__tests__/evolver.test.ts`: one case per level — `fs.write` and
  `fs.delete` (write), `test.run` and `shell.exec` (execute), `deploy.prod` (dangerous) — each
  returning `needs-approval` with the tool named; a tool the role already holds, or one an `add`
  grants after a `remove`, is judged as candidate-minus-current; an unclassified tool is not assumed
  harmless; the map is a required property (a `@ts-expect-error` call shape); the same edit on a
  safety-adjacent role returns `needs-approval` at b3; adding a read tool still ships; a loop case
  proves a widening manifest runs neither the critic, the smoke test nor the golden suite (the
  proposal is the only model call recorded); a loop case proves an unknown tool id is refused at
  `b-invariants`, naming the known tools, with no critic call; and
  `packages/cli/src/__tests__/eval-commands.test.ts` drives `maf evolve` end to end — the real
  registry, loop and gate, with a stand-in stack and adapter — and reads the recorded round: outcome
  `reject`, stage `b-invariants`, the unknown id and the known tools in the note, no critic call.
- **Proof the round is archived, not only reported (round 2, G8).** The loop tests above read
  `report.rounds`; none asked whether the round reached the graph. A test in the same file now
  drives a widening into a real Kùzu `MemoryGraph`, finds the `EvolutionRound` node, and reads it
  back **by id** — its kind, the run it belongs to, and the stored `outcome`, `manifest`, `note`
  and `gate` — which is how a later consumer reaches the round. Measured: N3e, the veto path
  pushing to `rounds` and never calling `record`, fails exactly this test and nothing else
  (25/26, on `the needs-approval round was written to the graph`).
- **Proof the command's permission map is the one the gate reads (round 2, G9).** The map is built
  in `cli/src/commands/evolve.ts` from `createDefaultRegistry()`, and nothing proved it reached the
  loop: mapping every tool to `read` at that construction passed the whole cli suite (M23).
  `packages/cli/src/__tests__/eval-commands.test.ts` now drives `maf evolve` end to end — the real
  registry, loop and gate; only the stack and adapter stand in — with a meta-model that widens the
  read-only `analyst` role with `fs.write`. The recorded round is `needs-approval` at
  `b4-write-tool-widening`, naming `"fs.write"`, with no critic call; under an all-`read` map the
  edit is not a widening and the manifest reaches the critic. Measured: M23 fails exactly this
  test (3/4 in that file).

### Every `.maf/` JSON file is read through one prototype-key reviver

- **`packages/types/src/protoKey.ts`** — `PROTOTYPE_KEYS`, `PrototypeKeyError` and
  `refusePrototypeKey(key, value)`: the `JSON.parse` reviver that refuses `__proto__`,
  `constructor` and `prototype` at any depth. It is the JSON counterpart of the rule
  `parseYamlDocument` already enforces for YAML configuration (F10), and it lives in the package
  every reader already depends on, so a reader added later reaches the same rule instead of
  copying it.
- **Routed through it** — every JSON reader whose path comes from the operator or from `.maf/`:
  the harness store's `<sha>.yaml` body and its `index.json`; the CLI's harness files (`--harness
  <file>` and the committed `default-<sha>.json`) and goldens result files; the golden corpus
  (`corpus.json`) in `GoldenRunner`, `maf evolve` and `maf goldens`, and `scripted.json` in the
  scripted adapter; a DAG workflow spec read as JSON; an attestation bundle and an in-toto
  statement; the evolver digester's graph-properties column; and the three memory-graph property
  readers. A refused document fails as a refusal, not as unparseable input: the store names the
  key and the file, the bundle says what it refused, and a properties blob is read as empty with
  the reason printed rather than as an object with one. The store's `readIndex` answers the same
  way as for an unparseable index — **no id resolves** — while the harness stays reachable by its
  sha, because the index is a lookup and the content is addressed by the hash.
- **Explained, not routed** — the remaining `JSON.parse` calls in `packages/*/src` parse what is
  not a configuration file: the attestation package's own `package.json`; an in-memory statement
  round-tripped through JSON in `Attestor.signedBytes`; a blackboard **value** read back from the
  blackboard's own sqlite column; and six inputs that are model output or a target repository's
  own `package.json` (the planner, the critic, the llm-judge, the security reviewer, the planning
  agent's plan block, and `test.run`'s runner detection). Each is read field by field and fails
  closed where the shape is wrong, and none is copied key by key into a prototype. A value or a
  model answer is data: refusing a document because a *value* names `__proto__` would reject data
  the run itself wrote.
- **Proof.** `packages/types/src/__tests__/protoKey.test.ts` pins the reviver for all three keys
  at depth and leaves an ordinary document alone;
  `packages/harness-config/src/__tests__/harness-config.test.ts` proves a harness file naming
  `__proto__` is refused with the key named and is **not** reported as "not parseable", and that a
  poisoned `index.json` resolves no id. Both were measured as mutants: removing the reviver from
  the harness-file read fails only the first test, and removing it from the index read fails only
  the second.

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

**A round that is only in the report was not archived (round 2, G8).** D-59 says the loop *records*
`needs-approval`; the graph write that makes the record durable was correct but untested, so a loop
that pushed the round to `report.rounds` and skipped the graph kept every test green. The proof is
now a real graph write read back by id. Rejected: asserting against the recording stub — it proves
`addNode` was called, not that a round is on the graph and retrievable, and the loop deliberately
swallows a recording error (L4), so a stub cannot tell a write from a failure either. Rejected:
reading the round back by querying its label or outcome — the id is what a consumer gets and holds.

**A passing suite answers on the runner's exit, not on its stdio (round 2, G16b).** The defect was
not the timeout's length: `close` by definition waits for the child's stdio, and a helper the suite
started keeps that pipe open for as long as it lives, so no timeout value turns 124 into 0 — it only
changes how long the operator waits to be told the wrong thing. Measured on the fixture before the
fix: `npm test` reported its own exit 0, and `close` had not arrived four seconds later. The fix
answers on `exit`, kills the group there — the kill is what closes the pipe — and reports the
child's status after a stated 100 ms grace, so the ordinary path is still answered by `close` when
it comes first. The grace is a constant with its reason in the code and is not a setting: a caller's
`timeout` is a budget for the suite, and this is not one. Rejected: a longer timeout — it converts a
pass into a slower pass only if the helper eventually exits, which is the case the defect excludes.
Rejected: `node --test` as the fixture — measured here, node's own runner waits for its file child's
stdio and hangs above MAF, so no tool-side fix can answer it; the shape a user hits is a runner that
exits while its suite's helper survives (`vitest` with a worker, an `npm test` that starts a server),
which is what the test reproduces.

**Order — invariants first, then b4, and both the moment the manifest exists (round 2, G3/G4).**
The two checks used to be asked at different moments and neither early enough. `gateWidening` ran
after the critic, so a widening manifest still cost a critic call; and the invariant refusal that
names an unknown tool lived only inside `gateEvaluate`, which ran after the smoke test and the golden
suite — the loop's earlier check was the widening rule alone, so an unknown tool id reached it, was
read as `dangerous` (the rule's fail-closed default for a tool the map does not name), and became an
approval request for a tool that does not exist. Both now run together as `gateStatic`, the moment
the candidate manifest exists, invariants first. Rejected: "run b4 before the critic and leave the
invariants where they were" — that keeps a malformed candidate on the approval path, and an approval
for a nonexistent tool is a decision nobody can honour. Rejected: dropping the check after a critic
revision — a revision can reintroduce either defect, and the check is free.

**One reviver for parsed files, and a refusal is not a syntax error (round 2, G5).** The
prototype-key refusal was implemented once, in `DagParser`, and every other JSON reader parsed
its file with a bare `JSON.parse`. That is the shape of rule that survives only until the next
reader is added: the YAML side already had one implementation, and the JSON side had one copy
per caller. The reviver now lives in `@maf/types` and every reader that takes a path from the
operator or from `.maf/` uses it, so `__proto__` cannot enter the harness store, the index, a
corpus, a bundle, a spec or a graph-properties blob. Two behaviours follow from the ruling and
are not incidental: a refused key is reported as a refusal and never as "not parseable" — an
operator reading "not parseable" would edit JSON that was syntactically fine — and a reader that
fails open on unparseable input (the index, the property blobs) fails open on a refused one too,
reading nothing rather than a partial object. Rejected: routing only the store. It is the file
the ruling named, but `maf attest`, `maf goldens` and `maf evolve` each read a file an operator
hands them, and a rule implemented at one of five call sites is the defect the ruling describes.
Rejected: routing model output and data values too. Those parsers read one known field and fail
closed on a wrong shape; refusing a *value* that happens to name `__proto__` would reject data
the run wrote itself.

**The environment is proved at every spawn site, by the child's own report (round 2, G6).** One
test per backend proved `invoke` and nothing else, so `sendTurn` — what a governed role actually
runs — and the probes were free to revert to `{ ...process.env }` without a red test. The new
stand-ins read their own environment rather than inspecting the options object the adapter built,
because the two are different claims: calling `backendEnv()` proves the policy was asked for, and
only the child's report proves what it received. Each spawn site has its own test rather than one
test driving all six, so a regression names the site instead of the record's length. Rejected: a
unit test that asserts `backendEnv()` was called. It is the weaker claim — an adapter could call it
and pass the result nowhere. Rejected: asserting a specific deny-list of variable names. The rule
is "no `MAF_*`", and a test that names two of them passes the day a third one is added.

**Rejected — keep `reject` and re-scope WP-3.7's live row.** A rejection does not guard the
decision, it removes it: a role is permanently denied a tool its operator may well have wanted,
and the answer arrives only after a candidate has been paid for. §6.3 already treats a change to
what an agent may do as the operator's call everywhere else — a prompt edit on a safety-adjacent
role (b3), a sensitive manifest (`--approve-sensitive`) — so rejecting a widening would be the one
place where the gate answers a question that was the operator's, and the live row that exists to
check exactly that would have to be rewritten to describe the weaker behaviour.

**Stated limit — the environment policy bounds what a child is handed, not what agent code can
find.** maf does not pass `MAF_SIGNING_KEY` or other `MAF_*` variables to processes it starts for an
agent. Agent code still runs as your user: anything your user can read, including maf's own
environment, agent code can read. Isolating the key needs a separate user or sandbox, which maf does
not provide. An earlier draft of this branch's `docs/SECURITY.md` bullet was headed "The key is in no
child process's environment", which promised more than the mechanism gives: a `test.run` child, or any
process the agent starts, can inspect the parent's environment with the user's own privileges
(`/proc/<pid>/environ` on Linux; same-user process inspection on macOS). The policy is still worth
having — it keeps the key out of what a backend logs, inherits into its own subprocesses, and reports
in an error — but it is one channel closed, not a boundary. The alternative — running agents under a
different user — is not in this WP; proposed for Wave 3.

## Files outside the spec's list, and why

The spec (`docs/BUILD_PLAN.md`, WP-3.9) lists `ProcessSpawner.ts`,
`packages/tools/src/plugins/{patch,test-runner,grep}.ts`, the config loaders,
`packages/evolver/src/gate.ts` and `docs/SECURITY.md`. This branch also changes:

| File | Why |
|---|---|
| `packages/types/src/childEnv.ts` (new) | The two environment policies need one home both `@maf/adapter-base` and `@maf/tools` already depend on. |
| `packages/types/src/index.ts` | Four additive changes, each marked `// WP-3.9`: the `childEnv` re-export, `ToolDeclarationError`, the optional `CliAdapter.preflight?()` and its `PreflightReport` result. Nothing existing changed shape. |
| `packages/cli/src/AdapterRegistry.ts` | `lookupAdapter` is split out of `resolveAdapter` so `maf run` can name an unknown adapter without asking whether its binary exists — preflight answers that better (G15). `resolveAdapter` keeps its behaviour for adapters that have no preflight. |
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
