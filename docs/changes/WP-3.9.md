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
  **Round 3 (H4) — the sentence above overclaimed.** Gemini has two spawn sites, `invoke` and the
  `--version` probe `isAvailable` asks; only the first had a test, so the probe could revert to
  `{ ...process.env }` and the suite stayed green, in the same round that claimed every adapter
  spawn site was proved. Gemini now has the probe test, written the same way; reverting the probe
  fails that test and nothing else, and `invoke`'s still passes — which is what shows the new test
  covers the probe and not the call beside it. The other two adapters' probes were grepped again
  and already had theirs (openrouter and ollama ask over HTTP, so they have no child to prove).

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
  with no `[TIMEOUT` in stderr, and the helper is reaped (G16b). Measured mutants, re-run in
  round 3 at this head's budgets because the file grew from 14 tests to 15 with H6: delete the
  `exit` handler → 13/15, failing G16b **and** H6 (both answer 124 at their 120 s guards for a
  suite that passed — the handler now owns two tests, not one); give `process.on('exit')` an empty
  body → 14/15, failing only the normal-exit test; drop `'SIGTERM'` from the hook's signal list →
  14/15, failing only the SIGTERM test (on the reaping assertion: without a listener Node's
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
  forms. It also covers a prototype key reached **through a YAML alias** — `a: &k __proto__`, then
  `*k : 1` (round 2, G17) — because the visitor resolves an alias key before checking it; measured:
  reading `pair.key` instead of `pair.key.resolve(doc)` lets the key through to `toJS` and fails
  that test.

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
- **`packages/cli/src/commands/run.ts`** (lines 209–231) — `maf run` looks the adapter up by name
  (`lookupAdapter`, a refusal that names only an unknown adapter), reads and validates a
  `--plan-from` spec if one was given, and only then calls preflight exactly once and plans: before
  a worktree, a store or a plan exists. The order is deliberate (D-59 merge duty 5): a malformed
  spec is refused without resolving or probing any backend, so the operator's own file is answered
  first and a wrong file cannot be reported as a wrong binary. Preflight runs *instead of* the
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
- **Proof of the order (round 3).** `packages/cli/src/__tests__/plan-from.test.ts` runs every
  malformed spec in its refusal table through both adapter shapes — one with a `preflight`, one
  with only `isAvailable` — and asserts all three counts stay zero: the availability check, the
  preflight probes and any invoke. Measured: restoring the pre-round-3 order (preflight before the
  spec) fails this test on the first count (`expected 0, actual 1`).
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
  scripted adapter; a DAG workflow spec read as JSON (`DagParser.fromYamlText`, and `--plan-from`'s
  file in `DagSynthesizer.fromFile`); an attestation bundle and an in-toto statement; a graph export
  file and the properties blobs it carries (`GraphTransfer`); the evolver digester's graph-properties
  column; and the three memory-graph property readers. A refused document fails as a refusal, not as
  unparseable input: the store names the key and the file, the bundle says what it refused, the
  `--plan-from` reader names the spec file, the export reader names the row, and a properties blob
  is read as empty with the reason printed rather than as an object with one. The store's `readIndex`
  answers the same way as for an unparseable index — **no id resolves** — while the harness stays
  reachable by its sha, because the index is a lookup and the content is addressed by the hash.
- **Explained, not routed** — the remaining `JSON.parse` calls in `packages/*/src` parse what is
  not a configuration file. The count is measured, not sampled: 33 call sites, 19 routed and 14
  here. Ten are model or provider output, each read field by field and failing closed on a wrong
  shape: the tool-call block (`adapters/base/src/turnProtocol.ts`), the JSON response and the
  streamed chunk in `OllamaAdapter` and `OpenRouterAdapter`, the judge's verdict
  (`eval-harness/src/judge.ts`), the planner's and the critic's verdicts
  (`evolver/src/planner.ts`, `evolver/src/loop.ts`), the security reviewer's
  (`git-ops/src/SecurityReviewGate.ts`), and the planning agent's plan block
  (`planning-agent/src/RetrievalAugmentedPlanner.ts`). Two are a `package.json`: the attestation
  package's own (`attestation/src/version.ts`) and the target repository's, for `test.run`'s
  runner detection (`tools/src/plugins/test-runner.ts`). One is a blackboard **value** read back from the blackboard's own sqlite
  column. One is an in-memory round-trip of maf's own object in `Attestor.signedBytes`. None is
  copied key by key into a prototype, and a value or a model answer is data: refusing a document
  because a *value* names `__proto__` would reject data the run itself wrote.
- **Proof.** `packages/types/src/__tests__/protoKey.test.ts` pins the reviver for all three keys
  at depth and leaves an ordinary document alone;
  `packages/harness-config/src/__tests__/harness-config.test.ts` proves a harness file naming
  `__proto__` is refused with the key named and is **not** reported as "not parseable", and that a
  poisoned `index.json` resolves no id; and
  `packages/cli/src/__tests__/goldens-offline.test.ts` proves the `scripted` adapter refuses a
  corpus that names one. The first two were measured as mutants: removing the reviver from the
  harness-file read fails only the first test, and removing it from the index read fails only the
  second. The third reader was the gap round 2 found — `GoldenRunner` and `maf evolve` routed
  their corpus read and `resolveGoldensAdapter` did not — so the sentence above was false for one
  of the three names it listed until that call site was fixed. Round 3 closed the remaining three:
  `packages/planning-agent/src/__tests__/DagSynthesizer.test.ts` refuses a spec whose node
  `metadata` names `__proto__` (and an edge-level `constructor`) with the file and key named, and
  asserts it is not reported as "could not read"; `packages/memory-graph/src/__tests__/
  graph-transfer.test.ts` refuses an export file naming `__proto__` in a node's properties (and
  `constructor` inside edge metadata) and a stored properties blob naming one, which the export
  refuses to carry into a new file. Removing the reviver at each of the three sites was measured:
  each owning test fails, and the other tests in its file stay green.

## Decisions

**D-59 · Child-process environment and runner hardening.** What a child of maf is handed, what a
test run may be asked and how long it may take, what `patch.apply` declares, and who answers a
role widening. Each part states what it rejected.

**(1) Two environment policies, because there are two trust boundaries.** A backend CLI (`claude`,
`codex`, `gemini`) is maf's own agent: it needs the user's toolchain and login state, so it gets
everything the user has minus every `MAF_*` variable (`backendEnv`; matched case-insensitively on
Windows, where the environment is). Rejected: an allowlist for backends — a CLI needs whatever the
user configured (a proxy, a private CA, a wrapper on `PATH`), and an allowlist cannot enumerate that
without breaking the machines that have one more thing set. Rejected: subtracting only
`MAF_SIGNING_KEY` — the next `MAF_*` secret is one release away, and the rule that survives a new
name is the prefix. A tool that runs project or model code (`test.run`, `grep`, `patch.apply`,
`git.*`) gets an allowlist instead (`toolEnv`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`;
`TMPDIR`, `TMP`, `TEMP`; `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_NUMERIC`,
`LC_TIME`, `TZ`; `TERM`; `NODE_EXTRA_CA_CERTS`; and the Windows set — `SystemRoot`, `windir`,
`ComSpec`, `PATHEXT`, `OS`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`,
`ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`. Rejected: a deny-list here — it has to name every secret and is always one
release behind the next provider's token (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, a CI token
somebody exported). Two exclusions are named because they are neither `MAF_*` nor tokens:
`NODE_OPTIONS` is a code-injection channel into every node child (`--require` runs a module before
the program), so a project's test run does not get it; `SSH_AUTH_SOCK` would hand a project's tests
the user's ssh agent, which reporting pass or fail does not need. Both policies are copies — a
caller may add to the result, and a child cannot mutate `process.env`.

**(2) What the policies do not remove.** Filtering bounds what a child is *handed*, not what agent
code can *find*: agent code runs as the operator's user, so `/proc/<pid>/environ` on Linux and
same-user process inspection on macOS reach maf's own environment. `docs/SECURITY.md` says exactly
that, and so does the recorded limits section here. Rejected: the sentence "the key is in no child
process's environment" — it promises more than the mechanism gives, and a claim that overstates a
boundary is itself the defect. A key file or a runner under a different user is Wave 3, not this WP.

**(3) `test.run` is bounded in what it may be asked and how long it may take.** The runner is a
fixed enum (`auto`, `bun`, `cargo`, `jest`, `node`, `npm`, `pnpm`, `pytest`, `vitest`), and a
filter beginning with `-` is refused before any argv exists. Each runner gets its filter the way
*that* runner parses one: after `--` for `bun` and `cargo`, as `--testPathPattern` for `jest` and
`-k` for `pytest`, and **deliberately not** after `--` for `vitest`, whose cac parser cuts argv at
`--` and drops the filter into `options['--']`, so `vitest run -- <filter>` silently runs the
whole suite. Rejected: passing the model's filter straight through — a leading `-` is an option
to the runner, not a filter, so a "test name" could become `--require` or an output flag;
rejected: one shared argv shape for every runner — the runners disagree about where a filter
goes, and the disagreement is silent. `vitest` and `jest` are invoked as `npx --no-install`, so a
missing runner fails by name instead of being downloaded from the registry — a network fetch and
code execution selected by a model-authored field. `timeout` defaults to 120 seconds and is clamped to
`MAX_TEST_TIMEOUT_MS`, fifteen minutes, however large the caller's value: a test command is a tool
call inside a node's budget, not a background job, and the value is model-supplied, so it is a
request rather than a bound. Rejected: no ceiling — a hung suite would hold the node and the run
indefinitely; rejected: honouring the caller's value unbounded — the one number an agent can pick
must not decide how long the run waits; rejected: a ceiling short enough to catch every hang —
that is the default, and a default that fires on a slow real suite turns a pass into a timeout.
Fifteen minutes is the point past which a suite's answer no longer arrives in time for the run to
use it. **The whole process group is killed on every exit maf observes.** The
runner is spawned `detached` on POSIX so it leads its own group, and `SIGKILL` goes to `-pid`,
reaching vitest workers and `npm`'s script shell; the group is killed on timeout, on the runner's
`exit` (a passing suite can leave a worker or a server behind — G16b), and when maf itself exits or
receives `SIGINT`/`SIGTERM`, where the hook kills every live group and re-raises the signal. The
call is answered on the runner's **`exit`**, with a stated 100 ms grace for `close` (G16b, below).
Rejected: signalling the runner alone — its workers survive; rejected: walking descendants by pid —
the kernel's group is the accounting, and a pid walk races reuse. Limits, recorded rather than
implied: a child that calls `setsid()`/`setpgid()` leaves the group and is not reached — and if it
inherited the runner's stdout, it also holds that pipe open, so `close` never arrives. The call is
still answered, by the grace, with the runner's own status (H6): measured, `exit 0` in 0.66 s with
the helper alive and still holding the pipe, so no `close` produced that answer. What maf cannot
recover is its own lifetime — a process that never killed that helper did not exit at all (alive at
5 s, ended only by the probe's alarm) — because the open pipe is an active handle until the helper
dies. A helper that stays in the group cannot do this: the group kill closes the pipe. Windows has
no POSIX groups, so only the runner is signalled; a `SIGKILL` to maf runs no handler, so the groups
it started survive it; and `ToolContext` carries no abort signal (G16a), so a `test.run` a failing
or abandoned node leaves in flight runs until its own timeout, at most the fifteen-minute ceiling.
Adding `signal?` to `ToolContext` is WP-3.5's decision.

**(4) `patch.apply` declares what `git apply` will write, before policy runs, and undoes a
part-applied change.** `git apply` is the applier (WP-3.9's header parser was superseded by the
0.5.1 hotfix, which reached this branch by merge-forward, CJ). Each call opens a sealed context: a
throwaway empty `GIT_DIR`, `GIT_WORK_TREE` at the worktree, system and global configuration off, and
`-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null`, so no
filter driver, hook or fsmonitor runs even when the repository defines one. The declared set is
git's own answer rather than a reading of the headers: `--numstat -z` forward and `-R --numstat -z`
in the reverse direction (every path either direction would write), plus `--summary -z` for the
create/delete/rename forms a path list cannot describe. The policy-approved set and the set
`execute` derives are compared both ways, and a call whose sets differ is refused before `--check`
and before anything is written. `--check` runs before the apply, so a diff git rejects there writes
nothing; absolute names and names containing `..` are refused by name; the temp diff is `0600` in a
private directory and removed in `finally`.

A structural conflict can still pass `--check` and fail part-way: `git apply --check` validates
each section against the current tree without simulating the sections before it, so a diff that
creates `x` and `x/y` (either order), or `x/y` and `x/y/z`, or a file where a non-empty directory
is, can have written earlier sections when a later one fails — every one of them declared and
allowed. Before the apply, each declared path and every ancestor is recorded: content and mode for
a file, the target for a symlink, the mode for a directory (K2), absence for a name that does not
exist. On a non-zero apply the recorded names are removed deepest-first and recreated
shallowest-first, a name of unchanged kind being rewritten because its content may have changed,
and directories the apply created are removed. What was restored is then verified against the
snapshot (K4): the report says `restored` only when every name, kind, mode and byte matches. If a
declared path cannot be recorded, the call is refused before anything is written: a write the tool
cannot undo is not one it makes. Rejected:
extracting the paths *inside* `execute` and assigning `input.paths` there — the policy engine
evaluates before `execute`, so it saw `paths: []` and the shipped `protect-secrets` rule was skipped
for the one tool it had been extended to cover. Rejected: moving the extraction earlier for
`patch.apply` alone — it fixes one tool and leaves the next input-mutating tool with the same hole;
the declaration is an interface member instead. Rejected: parsing the headers instead of asking
git — a parser can only see the forms it models, while `--numstat`/`--summary` answer for the bytes
the same git will apply. Rejected: undoing a part-applied change by applying the reverse diff — the
reverse fails on the same sections that failed forwards and needs every applied section to be
exactly reversible; the snapshot is bounded by the declared set, which is the set policy saw.
Rejected: no restore — a part-applied tree is neither the old one nor the new, and 0.5.1's
`CHANGELOG.md` promises the restore. Limit, recorded: the restore covers the declared paths and
their ancestors and nothing else, because a sealed `git apply` writes nothing else; a restore that
does not put the tree back is reported by name on stderr and as structured `restoreFailed: true` with
the paths, beside the apply's own error rather than replacing it (K4).

**(5) A candidate that widens a role with a write tool is the operator's decision, not the
evolver's refusal.** Stage `b4-write-tool-widening` answered `reject`: a candidate that added a
`write`, `execute` or `dangerous` tool to an ordinary role ended there, after the golden suite had
already been run. The verdict is now `needs-approval`, the gate outcome that names a decision a
human may make. Nothing else about the rule changes: the widening is still judged by each tool's
registry `permissionLevel`, still taken as the candidate's surface minus the current one, and a
candidate still cannot ship itself — `maf evolve` records `needs-approval` with the tools and the
role, and moves on without a smoke test or a golden run. No flag grants this particular approval:
`--approve-sensitive` decides stage b3 and nothing else — with it set, an edit targeting a
safety-adjacent role is evaluated in full, and its verdict is still `needs-approval`, applied only
by a human — and the widening rule runs whether or not it is set. What changed is who answers the
question. WP-3.7's live row holds on this verdict —
the row is the end-to-end check on what an operator is offered, and it is why this ruling is
recorded rather than left as an internal detail. The order the gate asks in — invariants first,
then b4, both the moment the manifest exists — is its own entry below.

**A sensitive edit is evaluated by permission and applied by a human (round 4, K1).** H1 read
`--approve-sensitive` as approval granted in advance, so a flag-on edit to a safety-adjacent role
could ship on its merits. Approving in advance something nobody has read is not a review, and the
reading let `maf evolve` ship an evolved `security` or `reviewer` prompt that no human had seen.
The flag now means *spend to evaluate it*: with it the edit gets the critic, the smoke test and the
golden suite, the candidate is stored with that evaluation, and its verdict is still
`needs-approval` — the gate downgrades its own `ship` for a sensitive target, so no path ships
one. Without the flag the round stops before the critic, as before. The evaluation is attached so
the human who runs `maf harness set-current <candidateSha>` decides with the evidence in hand; a
`reject` stays a `reject`. The candidate is saved, not made current: applying it is the reader's
act.

**A failed apply's restore is measured, not assumed (round 4, K2–K5).** The restore added in round 3
put back what it recorded, and three review findings said the record and the claim were both
narrower than the tree. *K2:* `git apply` removes a directory it empties (measured), so a failed
apply can destroy a directory the call never declared; the snapshot now records the mode of every
directory the apply might remove or create, and the restore recreates it with that mode — a `0700`
and a `0750` directory emptied by a failed diff come back as themselves, not as the umask's
`0755`. *K3:* what "restored" means is now checked rather than performed: content, mode and
existence for files **and** directories, and no extra path left behind. The fixtures carry
non-default modes (`0600` files, a `0755` executable, `0700`/`0750` directories) because a restore
that only rewrites bytes passes every default-mode fixture. Three mutants were measured dead:
restore content without mode (3 tests red), leave created directories behind (1 red — the shape
where the created directory's parents all existed, which no earlier fixture had), and snapshot the
declared paths without their parents (4 red). The third mutant is why the created-directory test
exists: in the original `x` file → `x/y` shape the restore removes the new directory as a side
effect of restoring `x`, so only a directory whose ancestors survived the apply can show it. *K4:*
only the verification decides. The tool attempts the restore and compares the tree against the
snapshot; only a verification failure is a restore failure, so an attempt that throws and leaves
the tree right is reported as restored, and an attempt that reports nothing and leaves a mode wrong
is not. The failure is structured — `restoreFailed: true` and the differing paths in the tool
result metadata, which the attestation carries as the call's recorded result, beside the message on
stderr. *K5:* the snapshot is a fresh `0700` directory under the system temp directory, file
contents are copied into it one at a time rather than read into memory, and the directory is removed
in a `finally` whatever the call did; the restore is no-follow — every parent component is
`lstat`ed, a symbolic link is refused rather than written through, and the refusal surfaces as a
verification failure, not as a replacement for the apply's own error.

**The restore follows no link in any pass (round 5, V-H1).** Round 4 stated that the restore was
no-follow, and the statement was narrower than the code: only the *write* pass checked its parents.
A reviewer raced the call — between the snapshot and the restore, a directory the call declared was
replaced by a link to a directory outside the project — and the removal pass followed it, deleting
files outside the project in three of the four shapes, as root and as an ordinary user; the check
read through the same link and reported "restored". There is now one resolver, and the removal
pass, the write pass and the verification all use it: it walks every component from the project
root with `lstat`, and a symbolic link anywhere on the walk refuses the name. A link found at the
name itself is refused too — the apply cannot have planted one (declaring a symlink is refused
before git runs), so it was planted by someone else and the restore does not decide what was meant.
A refused name is never removed, written or read through; it is named in `restoreFailedPaths` and
the call reports `restoreFailed`. The four shapes the reviewer raced are tests, plus a root swapped
for a link, asserting the outside tree is byte-identical afterwards and that the refused names are
reported. Rejected: unlink the link and rebuild the name — it restores a tree the racer moved and
reports it as restored. Rejected: `openat`-style handles — Node exposes no directory-relative
`unlinkat`, so a `lstat` walk that refuses links is the strongest check available, and a race
between that walk and the operation is the same race `git apply` itself has. That window is stated
in `docs/SECURITY.md` rather than implied closed: Node has no directory-relative `openat`/`unlinkat`,
so a link planted in it may let that one operation follow the link, and the next component, or the
verification that follows, refuses and reports it as `restoreFailed` — the call never reports a
restore that touched a planted link as restored. The race tests exercise that path
(round 6, V5-L1; reworded in round 7, V6-L1).

**The restore's tests measure what its sentences say (round 5, V-L1–V-L5).** `treeState` compared
modes without the setgid bit (`& 0o777`, not `& 0o7777`), so a fixture's `02755` file lost the bit
unobserved; it now compares `& 0o7777` and the fixture carries `02755`. A same-length content change
to a blob after the restore is a test (a new `beforeVerify` seam), so a verification that compares
only size and mode dies. `beforeRestore` receives the snapshot directory and the test sets its own
`TMPDIR`, so it reads the directory the call made instead of scanning the shared temp directory. A
git child killed by a signal reports `git apply was killed by <SIGNAL>` in its stderr and result
instead of exit 1 with empty stderr, with a stand-in that kills itself. The snapshot-creation
`catch` is unreachable in a normal call and says so rather than pretending to be tested. The three
seams — `beforeRestore`, `beforeWrite` and `beforeVerify` — are marked `@internal` (test-only) on
the exported `PatchApplyTool` options, so they are not read as part of the tool's surface (round 6,
V5-L2).

**Two restore mutants that survived round 4 now die (round 5, K5e, K4d).** The write pass unlinks
a name before it creates something there; with the earlier fixtures that unlink was unobservable,
because the removal pass had already cleared every name whose kind changed and the write pass
refused every link. A new `beforeWrite` seam — between the two passes — lets a test rename a live
UNIX socket onto a file name the restore is about to write: the unlink replaces it and verification
passes, while a mutant that drops the unlink hands the socket to `copyFileSync` and the restore
reports the name (1 test red). The verification's mode comparison was likewise unobservable, because
the restore itself writes the snapshotted mode; a `beforeVerify` `chmod` to a different mode leaves
the bytes right and the mode wrong, and a verification that compares content alone reports the tree
restored (1 test red). At this head the five restore mutants measure K5c 4 tests red, K5e 1, K3a 4,
K4d 1, K4f 1.

**The round's own verification found one more instrument defect (V-L6).** The seven process-group
tests in `test-runner` answered "is the grandchild gone?" with `kill(pid, 0)`, which succeeds for a
process that was killed but whose new parent has not reaped it. In a container whose pid 1 does not
reap, all seven fail although the group was killed — measured as root with `sleep` as pid 1 and as
an ordinary user under a `su` that adopts orphans without reaping them. The probe now reads state
field 3 of `/proc/<pid>/stat` and treats `Z` as gone (platforms without `/proc` keep the signal
answer), after which the seven pass in that harness; the product code was already right. The
ordinary-user verification below runs in the same `su` harness that failed before the probe changed.

**The documents name a command that exists (round 5, M1).** The K1 paragraphs told the operator to
apply a sensitive candidate with `maf evolve approve <id>` — WP-3.7's command, not built yet. Today
typing it starts a new evolve session and spends money. The evaluated candidate is now saved to the
harness store **without** becoming current, and `maf harness set-current <candidateSha>` — which
exists — applies it. Every copy of the sentence says that, and says WP-3.7 will add `maf evolve
approve` as a shortcut; `maf evolve` also refuses a positional argument, so the old line exits
non-zero instead of evolving. Tests: the command refuses `approve <id>` without building an
adapter, and a flag-on candidate's sha is in the store and not current, then current after
`set-current`.

**Every string the injector renders is escaped (round 5, M2).** Round 4 escaped summaries, recent
messages and ghost cues; a node's label and properties were masked but not escaped, so a label
carrying `</memory-graph><ghost id="forged">` could close the block and forge a cue. `formatNode`
now renders `escapeXml(redactText(…))` for the label, the property names and the property values,
and the id, kind and edge relation are escaped as well; a test drives the forged label through a
real assembly and a mutant that drops the escape turns it red. Round 6 gives the two code-written
values their own hostile input — a node's `kind` and an edge's `relation`, both rendered inside
attributes — and the mutants that drop either escape turn the test red (P2).

**M1's guarantee is held by the real wiring's tests (round 6, P1).** Saving an evaluated sensitive
candidate and applying it are two acts. The suite proved the loop's use of `storeCandidate`, but
nothing held `evolve.ts`: a `storeCandidate` that also set CURRENT, one that stored nothing, and
one whose candidate also ran `onShip` — which, in the real wiring, ships a sensitive edit with no
human — each left every test green. Reviewer A's end-to-end probe is now a test: the real command,
loop, gate and `HarnessStore`, with only the adapter and the stack standing in. It asserts the
candidate's sha is in the store, CURRENT has not moved, the `STORED` line names `maf harness
set-current <sha>`, no `SHIP` line is printed, and `set-current` then applies it; the loop's M1
test also asserts `onShip` is never called. All three mutants are dead (one test red each, restored
and sha256-verified).

**The base moves only on a ship (round 7, Q1).** A one-round test cannot see a loop that adopts a
stored, unapproved candidate as the next round's base: the second round then ships an ordinary edit
on top of the unread sensitive prompt, and in the real wiring that `onShip` makes the harness CURRENT
with no human. Reviewer A's two-round probe is now two tests. The loop test runs a flag-on `security`
edit (round 1, `needs-approval`, stored) and then an ordinary `coder` edit (round 2, ships), and
asserts the shipped harness's `security` prompt is the base's, that its id and sha are the ordinary
edit applied to the pre-round-1 base rather than to the stored candidate, and that every harness a
ship receives leaves the safety-adjacent roles untouched. The `evolve.ts` test drives the same two
rounds with `--rounds 2` through the real command, gate and store, where the assertion is on what
`onShip` made CURRENT. The mutant (`base = finalCandidate` after storing the candidate) turns both
red; it left the whole suite green before.

Limits, stated in the present tense: there is no crash recovery — a `SIGKILL` between the apply's
first write and the restore's last leaves the tree part-applied, and the snapshot directory the
`finally` would have removed is left behind and is never consulted, so nothing repairs the tree on
the next call; and a successful edit takes git's file mode as in 0.5.1, so a restore is what
preserves a mode, not an apply.

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
corpus, a bundle, a spec, a graph export file or a graph-properties blob. Two behaviours follow from the ruling and
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
Round 3 (H4) completed the claim: gemini's probe had no test until then, and the entry above
records the gap and its measurement.

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
| `packages/planning-agent/src/DagSynthesizer.ts` | `--plan-from`'s spec file (content merged from #54) is read through the shared reviver; a refused key is reported as a refusal naming the spec file (round 3, D-59 merge duty 1). |
| `packages/memory-graph/src/GraphTransfer.ts` | A graph export file and the stored properties blobs it carries (WP-3.8, merged base) go through the same reviver; a refused key is named and the import or export refuses (round 3, G5). |
| `packages/evolver/src/{gate,loop,index}.ts` | The widening rule (exported as `gateWidening`), the required permission map, and the pre-spend check. |
| `packages/cli/src/commands/evolve.ts` | Supplies each tool's `permissionLevel` from `createDefaultRegistry()`. |
| Tests | `packages/adapters/base/src/__tests__/ProcessSpawner.test.ts`, `packages/adapters/{claude,codex,gemini}/src/__tests__/backend-env.test.ts`, `packages/adapters/claude/src/__tests__/preflight.test.ts` (claude only: it is the only adapter with a `preflight`), `packages/types/src/__tests__/childEnv.test.ts`, `packages/tools/src/__tests__/{patch,test-runner,git-args,grep-args,worktree-confinement,input-schema}.test.ts`, `packages/git-ops/src/__tests__/SnapshotDiff.test.ts`, `packages/eval-harness/src/__tests__/verifier-env.test.ts`, `packages/cli/src/__tests__/{preflight-wiring,fixture-tests-env,ConfigLoader,approval-gate-stack}.test.ts`, `packages/policy-engine/src/__tests__/parseYamlDocument.test.ts`, `packages/dag-runner/src/__tests__/{spec-keys,failure-recorder}.test.ts`, `packages/roles/src/__tests__/roles-file-loading.test.ts`, `packages/planning-agent/src/__tests__/{failure-recall,DagSynthesizer}.test.ts`, `packages/memory-graph/src/__tests__/graph-transfer.test.ts`, `packages/cli/src/__tests__/{preflight-wiring,plan-from}.test.ts` (both listed above), `packages/tool-loop/src/__tests__/declaredPaths.test.ts`, `packages/evolver/src/__tests__/evolver.test.ts`. |
| `docs/SECURITY.md` | States each boundary as implemented, including the three limits on the group kill. |
| `docs/changes/WP-3.9.md` | This fragment. |

The spec's "config loaders" item is discharged in `parseYamlDocument` (the loader every config,
policy and roles file goes through) rather than in `ConfigLoader.ts`; that is recorded above rather
than claimed as a change to the loader.

### Overlap with WP-3.2 (#52)

Measured at the merge: **22 paths** were touched by both branches and **7 conflicted**; the rest
auto-merged. The branch merged `wp/phase-3b` as `9e412af` and resolved all seven — the three
adapters (the child's allowlisted `backendEnv()` from this branch, #52's model surface composed
before the spawn and attached on a throw), `cli/commands/run.ts` and `types/index.ts` (unions of
both import and export lists), `GraphAwareInjector.ts` (`escapeXml(redactText(…))` everywhere in
the file — #52 supplied the text, this branch the mask — with `formatSummaries` redacted at render
on merge duty 2's reasoning), and the comment-only `approval-gate-stack.test.ts`.

### Overlap with WP-3.6 (#54) and WP-3.7

`packages/dag-runner/src/DagParser.ts` is WP-3.6's, and this branch changes it (the `JSON.parse`
reviver for a workflow spec). #54 — WP-3.6's own fixes — changes the same file. Measured with
`git merge-tree` against #54's head `29d7641`: three files are shared with this branch —
`DagParser.ts`, `packages/cli/src/commands/run.ts` and `packages/types/src/index.ts`. The first and
third auto-merge; `run.ts` conflicts, because both branches' changes sit inside `runTask`.
Whichever lands second resolves it. The PR body lists the range this branch touches.

`packages/evolver/**` and `packages/cli/src/commands/evolve.ts` are WP-3.7's. This branch changes
them for the widening rule — the `needs-approval` verdict, the required permission map, the
pre-spend check, and the round written to the graph — so WP-3.7 starts from those changes rather
than from the pre-3.9 files.

### The `claude` preflight check

It **is** in this branch — see the section above. An earlier draft of this fragment said it was
not: at that point the branch only gave `ClaudeAdapter.isAvailable()` a `backendEnv()`, and the
flag-support check was added afterwards.

## Verification

Measured at `0daa681`; `0daa681` is the last commit that changes code, and every commit after it is
documentation.

- `pnpm -r build` clean on both hosts and `pnpm -r typecheck` clean on macOS, and `grep "error TS"`
  over every build log = 0.
- **Linux (the arbiter), as root and again as an ordinary user: `pnpm -r test` — 1658 tests,
  1656 passed, 2 skipped, 0 failed** in both runs. Each is a `node:22-bookworm` container over a
  `git archive` of the head with the container's own empty store: `pnpm install
  --frozen-lockfile`, `pnpm -r build`, then `pnpm -r --no-bail --workspace-concurrency=1 test`
  (`TEST_RC=0`). The ordinary-user run is the `su` harness whose pid 1 does not reap — the one that
  failed before the V-L6 probe change (above) — and it is green there. The two skips are
  `packages/tools`' ripgrep test (`ripgrep is not on PATH`) and `packages/cli`'s real-adapter LCM
  test.
- **macOS (this host, Node 22.17.1, pnpm 10.34.7), from a clean tree with no `dist/` and no
  `*.tsbuildinfo` (`pnpm install --frozen-lockfile --offline`, `pnpm -r build`), then a serial
  suite (`--workspace-concurrency=1`): 1658 tests, 1656 passed, 2 skipped, 0 failed.** The two
  skips are the same pair. The `packages/roles` timing bound that was red under workspace
  concurrency in round 3's Mac runs — "the reviewer was never asked", its own 5 s bound — passed
  here, as did every other package; that file is another lane's and was not edited.
- **The five repository guards, on both hosts, all `OK`:** `check:test-scripts` (`test-script
  guard: 25/27 packages declare a test script that runs their src/__tests__ tests`; the two with
  none are `@maf/blackboard` and `@maf/lcm-adapter`), `check:build-output` (27/27 packages emitted
  the entry point their `main` names), `check:workspace-deps` (27 packages, 94 internal edges,
  acyclic), `check:doc-refs` (84 `.md` references across 5 dirs + 4 root files, all resolving),
  and `check:package` (`36 files, installed and run`, its demo at `goldens solved 4/10`).
- **The spawn-heavy `test.run` fixtures were the other macOS flake, and are fixed here**
  (`354f24d`, `c178595`). A fixture's own `node` startup took 17.3 s while `patch.test.js` ran
  beside it, and the G16b call 29.5 s under the nine-file `tools` suite; the fixtures' 2 s pid
  poll, 2 s timeout guard and 8 s/10 s `npm` guards were below that, so four `tools` tests failed
  for latencies unrelated to the code under test, while they pass alone and on Linux. The poll is
  now 120 s and the two `npm` guards 120 s; the timeout test was returned to a 750 ms timeout in
  round 4 (J3, with an elapsed guard below 5 s) — test-only, assertions
  unchanged, and the three round-2 mutants re-measured above. After that change, at the head it
  was measured at, `tools` was 129 tests, 128 passed, 1 skipped, 0 failed in the same parallel run;
  rounds 4 and 5 add their own tests, and at this head the package is 149 tests, 148 passed,
  1 skipped, 0 failed.

## Recorded limits

- Group kill reaches a process group, not a descendant tree. A child that leaves the group
  (`setsid()` / `setpgid()`) is not reached by `-pid`; a Windows child tree is not reached either,
  since only the runner is signalled; and a `SIGKILL` to MAF runs no handler, so the groups it
  started survive it. `docs/SECURITY.md` states all three rather than implying a guarantee.
- On Windows there are no POSIX process groups; `test.run` signals the runner alone, and the
  section in `docs/SECURITY.md` says so.
- An abandoned `test.run` is not cancelled. `ToolContext` carries no abort signal (G16a), so a call
  left in flight by a failing or abandoned node runs until its own timeout — bounded by the
  fifteen-minute ceiling, but not by the node. Adding `signal?` to `ToolContext` is WP-3.5's call;
  `docs/SECURITY.md` states the limit beside the group kill.
- `patch.apply` is still confined by the policy engine only (the tool does not re-resolve the paths
  it declares), and a direct call that skips the policy layer gets no confinement. `docs/SECURITY.md`
  already states this; the declaration above is what lets a path rule see the files at all.
- `--approve-sensitive` changes only whether an edit targeting a safety-adjacent role is evaluated:
  without it the round is archived unevaluated as `needs-approval`; with it the candidate is
  evaluated in full — critic, smoke test, goldens — and its verdict is still `needs-approval`,
  stored with that evaluation and applied only by `maf harness set-current <candidateSha>`. The flag
  is permission to spend, not to ship: a sensitive edit never reaches `onShip`, whatever the evaluation says, and
  the gate downgrades its own `ship` to `needs-approval`. `maf evolve` has no interactive approval,
  so without the flag there is no way to answer the question inside the run — and with it the
  answer is still the operator's, made with the evaluation in hand. The flag decides stage b3 only
  — a tool widening still needs the operator. `docs/SECURITY.md` states this rather than implying
  that the flag approves a ship.
- A `needs-approval` from the widening rule has no flag that grants it: `maf evolve` records the
  tools and the role and stops. The operator grants a widening by authoring it; there is no
  `--approve-widening`, and this branch does not add one.
- `preflight` is asked once, by `maf run`, after a `--plan-from` spec (if any) is accepted and
  before anything is planned; `goldens` and `evolve` do not ask it. It proves `claude --help` lists
  `--tools`; a binary that lists the flag and rejects it at run time still fails at the first node —
  one sentence later than before.
- The prototype-key refusal covers keys a **file** names: every reader above parses text.
  `DagParser.fromSpec` takes an already-built object from a programmatic caller and parses no text;
  that caller is trusted by construction.
- Redaction at the memory boundaries is pattern-based, on the broad `redactText` set rather than
  credentials-only, applied on write and again on read-back. A secret in a format no pattern
  recognises is masked by neither.
