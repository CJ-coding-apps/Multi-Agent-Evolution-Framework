# Changelog

Notable changes to maf. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

maf is pre-1.0 with no known outside users, so breaking changes land in the unreleased section
rather than behind a major bump. They are still listed as breaking, because a reader of this file
is entitled to know which of their own code stops compiling.

## [Unreleased]

## [0.3.0] - 2026-10-09

The governed-by-default execution model, and the wiring the 0.2.1 README listed as planned: writer roles
run in MAF's in-process loop by default, an `Escalate` verdict asks a person, a human review gate, worktree
isolation, `.maf/config.yaml` and a YAML `roles.yaml`, planner failure recall, offline evaluation, an
in-toto attestation with `maf attest verify`, and a harness that is the content a run dispatched. Phase 2
of [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md); D-nn cite [docs/DECISIONS.md](docs/DECISIONS.md). Not in this
release: the toolchain floor (D-21, WP-2.11), and `allowPartial` set from a DAG spec or by the planner —
the README's Status table lists both as planned.

### Security

- **Writer roles run governed by default** (D-01). Every role ran on the `cli` tier unless it opted in, and
  no shipped role did, so no writer's tool call was ever seen by the policy engine, redaction or the
  attestation. A role that holds a write tool now runs in-process
  unless its `execution` says `cli`. A writer that would land on the `cli` tier — by that setting, or
  because the adapter cannot run the loop (`codex`, `gemini`, `ollama`, `openrouter`: only `claude` can) —
  is refused: `maf run` refuses before planning, naming the roles, and the dispatcher refuses again before
  the node captures anything or calls a model. `--allow-ungoverned` runs such writers on the `cli` tier and
  prints an `UNGOVERNED` banner once; the transcript notes each such node. A read-only role still runs on
  the `cli` tier.
- **An in-process turn spawns `claude` with its own tools off** (D-33, found by the WP-2.1 verifier). Under
  D-01 every writer on `claude` ran through `sendTurn`, whose `claude --print` still had Claude Code's
  built-in tools: within a single turn, before its answer reached MAF, the backend could edit files outside
  policy and attestation wherever the user's `permissions.allow` let it. A governed turn now passes
  `--tools ""` beside the MCP isolation below, so the only tools in the loop are MAF's. This needs a Claude
  Code CLI that has the `--tools` flag. Codex has no known equivalent and keeps `inProcessLoop` off.
- **`claude` no longer starts the user's MCP servers** (carried from the WP-1.12 fresh-clone proof, where a
  third-party MCP server's dashboard opened once per spawn). Every `claude` spawn, on either tier, passes
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. `gemini` gets `--allowed-mcp-server-names`
  naming a server no configuration defines; that is not verified against a live `gemini`. `codex` has no
  known flag and gets none.
- **`Escalate` asks a person; a headless run refuses** (D-02). `Escalate` was refused exactly as `Deny`
  was, and `@maf/approval-gate` was not used by `maf run`. Now, when stdin is a terminal, the gate prompts
  on stderr with the rule, the tool, the declared paths, an escaped and bounded preview of the input, the
  request id and its hash, and the call runs once if the operator types the six-character code made for
  that request — so a `y` typed ahead, or a code typed twice, approves nothing. With stdin not a terminal,
  or `MAF_HEADLESS=1`, nobody is asked: the call is refused and recorded at
  `.maf/approvals/pending/<id>.json`. No answer within 120 seconds of the prompt appearing refuses the
  call. Each decision is bound to a sha256 of the tool id, input, declared paths and rule id; the gate
  refuses another hash, another request's decision, a reused request id and an input changed while the
  person decided, and a provider that answers nothing or a gate that throws is a refusal. Every decision is
  attested. The code that read a merged GitHub pull request as an approval (`GithubPrReviewer`), which
  nothing called and nothing bound to the request, is removed.
- **A human review gate** (D-34). A harness's `reviewGate: { required: true }`, or `--review`, puts each
  writer change the security gate passed to a reviewer at the terminal; see Added. Its `ReviewGate`
  replaces one that read the diff itself and answered any error reading it with an empty diff, which it
  then approved, and whose model-based review saw only the first 8,000 characters. A required review fails
  closed: with no one to ask, every writer change is refused with `ReviewRefused`.
- **MAF no longer edits your checkout** (D-03). A run edited the target working tree in place, on its
  current branch, and `--no-worktree` had no effect. Each run now works in its own worktree and branch and
  hands its work back as a merge command it does not run; see Added. A run branch that commits MAF's
  runtime state — which the security gate never reviews — is offered no merge, and the run exits non-zero
  (D-35).
- **The agent's `git.*` tools no longer run hooks or the host's git configuration** (WP-2.14, found by the
  WP-2.10 verifier). They ran git with the host's configuration and the repository's hooks: under a
  relative `core.hooksPath` such as husky's `.husky`, an agent could `fs.write` a `pre-commit` hook and then
  call `git.commit`, which ran it outside every gate; the host's global `commit.gpgsign` and identity
  applied to the agent's commits. Every git command the tools run now pins `core.hooksPath=/dev/null`,
  an empty `core.fsmonitor` and `commit.gpgsign=false`, ignores the host's global and system configuration
  and the git configuration exported through the environment, and never prompts. `git.commit` uses the
  repository's own identity and names `maf` only for what the repository leaves unset. Not closed:
  repository configuration that names a program (`diff.external`, a `textconv` or filter driver,
  `gpg.program` with `log.showSignature`) still runs it; see docs/SECURITY.md.
- **The attestation is an in-toto Statement signed over RFC 8785 bytes** (D-13, D-36). The bundle was
  MAF's own JSON, signed over `JSON.stringify` in the order its fields happened to be written, so no third
  party could reproduce the signed bytes and a re-serialized bundle no longer verified. It is now an
  in-toto Statement whose subjects are the writer nodes' diffs (`recordDiffHash` had no production caller)
  and whose predicate is the run record, `keySource` inside it; the signature is HMAC-SHA256 over the
  statement's RFC 8785 form (`jcs.ts`). A statement whose subjects are not exactly its `diffHashes`, or
  that names no `keySource`, does not verify, and a signature must be the exact lowercase hex digest.
  `approvals`, always empty before, now holds every approval-gate and review-gate decision.
- **A run's recorded harness is the content it dispatched.** `legacy-default` was minted once from
  `roles.yaml` and never again, and the sha covered a role's `promptFile` path but not its text, so a run's
  attestation could name a role set and prompts other than the ones that ran. A plain run now mints
  `legacy-default` again from the roles file and the text of each prompt file, dispatches from that harness,
  and attests `configSource` as the stored harness file and its sha, re-verified at the end of the run.
  `goldens` and `evolve` resolve their harness the same way; they loaded `current` directly and could
  evaluate a stale snapshot whose prompts were read from disk, outside its sha.
- **A roles file that exists but cannot be read no longer falls back to the built-in roles** (D-08). A
  roles path that was a directory, unreadable, or a dangling symlink was answered with the built-in set,
  whose default role is a writer. Only a path where nothing exists gets the built-in roles now; anything
  else stops the run with a `RoleConfigError` naming the file. A role whose `execution` is anything but
  `cli` or `in-process` — `inprocess`, say — is refused; it ran on the `cli` tier. A YAML merge key (`<<`)
  in `roles.yaml` or `config.yaml` is refused at any depth, naming the file and line (D-40): YAML 1.2 has no
  merge, so it loaded as a literal key and the fields it was meant to bring in were silently missing.
- **The agent's tools cannot leave the run's worktree** (F1 of the release audit). With no policy file, an
  agent could `fs.delete .git` and then `git.reset --hard`, which git — finding no repository in the
  worktree — ran on the user's checkout above it; or rewrite `.git` to `gitdir: <repo>/.git` and commit
  onto the user's branch. `fs.write`, `fs.delete` and `patch.apply` now refuse any path into `.git`, at any
  depth and in any case, before policy and again on the resolved path; the refusal is a `Deny` under rule
  id `builtin:git-dir`, attested in the bundle and reported to the agent, whose node goes on. The git
  tools learn the run's repository root once, from the project root, and every git tool asks git which
  repository it found before each call and refuses unless it is that one, with `GIT_CEILING_DIRECTORIES`
  at the root's parent and the host's `GIT_DIR`, `GIT_INDEX_FILE` and other repository variables dropped:
  a run pointed at a subdirectory works there, its git confined to the repository root. MAF's own git
  calls drop the same variables and pin `core.fsmonitor` too. `test.run` runs the project's own command
  and is not confined; docs/SECURITY.md says so.
- **The reviewed diff shows the change whatever `.gitattributes` says** (F2 of the release audit). An
  agent-written `*.js -diff` turned its change into "Binary files differ" in the diff the security gate and
  a human reviewer were shown, and the attestation signed that. `snapshotDiff` passes `--text
  --no-ext-diff --no-textconv`; a genuinely binary file prints as bytes and is refused by the gate's cap
  when it cannot be reviewed whole. A filter driver the repository configures still shapes what is staged.
- **The planner's and the security reviewer's calls run without the backend's own tools** (F4 of the
  release audit). Both are `cli`-tier calls that need only text, yet `claude` kept its built-in tools, so
  the reviewer could edit the tree it had just passed. `AdapterInvokeOptions.nativeTools: false` gives
  `claude` `--tools ""` on `invoke` and `stream`; `codex` and `gemini` know no such flag and keep theirs.
- **A prompt is never read as an option** (F5 of the release audit). The prompt followed `-p`, which is
  `claude`'s boolean `--print`, so one starting with `-` — a node description the planner wrote — was
  parsed as options such as `--settings=<json>`. `claude` now gets `--` before the prompt; `gemini`, whose
  `-p` takes the prompt as its value, gets `--prompt=<text>`. Checked against a stand-in spawner, not yet
  against live binaries.

### Added

- **`--allow-ungoverned`** on `maf run`, `maf goldens run` and `maf evolve` (D-01; see Security).
- **`expectsChange` and `no_change`** (D-32). A role that sets `expectsChange: true` — in the built-in
  set and this repository's `.maf/roles.yaml`, only `coder` — fails with `NodeFailure('no_change')` when
  its `cli`-tier node answers, exits 0 and leaves no diff against its start commit, the output tail in the
  error. That is what a backend that refused the edit under its own permission settings looks like, and
  0.2.1 reported it `Succeeded`. Only a writer may set it.
- **The human review gate** (D-34). `maf run` builds it when the harness sets
  `reviewGate: { required: true }` or `--review` is given. The terminal reviewer shows the node, its role,
  the base commit, the diff's sha256 and the diff (up to 200 lines or 20 KB), and reads `approve` or
  `deny`; an answer typed before the prompt is discarded, and the end of input denies at once. The node
  waits for the decision, up to 10 minutes. Required: anything but an approval fails the node with
  `ReviewRefused`, a verdict that is never retried. Advisory (`--review` alone): the decision is recorded
  and the node completes. `--review` with no terminal prints one line and runs without a gate. The review
  runs for the roles the security gate reviews, after it passes a change, on either tier. `reviewGate` is
  part of the harness and its sha; `maf evolve` carries a parent's into every candidate it builds.
- **Worktree isolation** (D-03, D-35). `maf run` creates `.maf/worktrees/<runId>` on a new branch
  `maf/<runId>` from HEAD, prints its path, and runs the planner, the agents and the security reviewer
  there. On success it commits what the run left uncommitted (as `maf <maf@maf.invalid>`, unsigned, hooks
  off, runtime state excluded) and prints `git merge maf/<runId>`; a branch still at its base gets a
  "changed nothing" line instead; a branch that commits runtime state is refused (exit non-zero, paths
  named); a failed run keeps its worktree and prints its path. MAF never deletes a worktree or a branch. A
  directory with no commit, or with no committed files, is refused before any agent work, naming
  `--no-worktree`. With uncommitted work in the target, the run warns that it will not see it.
  `--no-worktree`, or `worktree: false` in `.maf/config.yaml`, runs in place after a warning naming which
  of the two turned isolation off; with uncommitted work in the tree there, it warns that the gates will
  see it as the run's own, and refuses `--review`.
- **`.maf/config.yaml` is read** (D-08). Keys: `adapter`, `model`, `worktree`, `lcm` (`mode`,
  `contextThreshold`, `freshTailCount`), `dag` (`maxConcurrent`, `retry`), `timeouts` (`planMs`,
  `securityReviewMs`). Precedence is per key: a flag the user typed (`-a/--adapter`, `-m/--model`,
  `--no-worktree`), then the file, then the built-in defaults, which are the values 0.2.1 hard-coded. See
  Changed for the migration.
- **Planner failure recall** (D-16, D-37). The planner's query matched nothing a run wrote. A failed node
  is now recorded once, after its last attempt, by `DagRunner`'s failure recorder: a `Task` (the node's
  instruction, with the run's title, role and node id in its properties) joined to a `Failure` (reason,
  message, exit code) by a `MemoryEdge {relation: 'CAUSED_FAILURE'}`. The planner recalls up to five, most
  recent first, whose Task text contains the first three words of the new title, ignoring case, into a
  `<past-failures>` block; `FailurePatternDetector` reads them through the same query (`recallFailures` in
  `@maf/memory-graph`). The recorder's wait is bounded at 10 seconds. `querySubgraph` now filters before
  it limits, so a match written after more than `maxNodes * 3` other nodes is still found.
- **Offline evaluation** (D-14, D-38). `maf goldens run --adapter scripted` runs the golden corpus
  without a model, a key or an earlier `maf run`, through `ScriptedAdapter` (now in `@maf/eval-harness`)
  and `tests/goldens/scripted.json`. A default harness (`.maf/harnesses/default-425ac38e….json`) and its
  result (`tests/goldens/baseline.json`) are committed; `goldens` evaluates `--harness`, else CURRENT, else
  that default. Each evaluation runs in a temporary stack whose graph is emptied before every attempt, so
  nothing from the project's graph or an earlier attempt reaches the prompt. Results record the corpus sha,
  the attempt count, the adapter, the model and who judged. Coder tasks protect their test file
  (`mustNotModify`). The judge's prompt and parser now agree (JSON `{passed}`); `--judge-adapter` and
  `--judge-model` choose a judge, and the result says when the agent judged itself.
- **`maf harness import <file>`** (D-19, D-39): validates a harness file, copies it into the store and
  indexes its id; it refuses the reserved ids `legacy-default`, `current` and `CURRENT` (in any case) and
  an id already bound to other content. Harness refs now accept a unique sha prefix of four or more hex
  digits, and the committed default answers to its id and sha.
- **`maf attest verify <bundle>`** (D-13): prints `valid`, the `keySource` it checked against, the number
  of subjects and, for a 0.2.x bundle, `legacy: true`; exits 1 with the reason when the bundle does not
  verify, cannot be read or is not a bundle.
- **`[maf] harness: <id> (<sha>) [<source>]`**: `run` says which harness it dispatches and why (`legacy`,
  `current` or `flag`), and prints the worktree it works in.
- **`--adapter scripted`**: the offline adapter is in the adapter registry. It answers the security gate
  and the judge, and refuses any task it has no script for.
- **CI job `e2e · demo · attestation · offline goldens`** (D-24): builds, runs `inprocess-demo`, checks its
  bundle with `maf attest verify` (and that it does not verify under another key), runs the offline
  goldens in the checkout and compares the result with `tests/goldens/baseline.json`, `ranAt` aside
  (`scripts/compare-goldens.mjs`, with its own `--self-test`).

### Fixed

- **Kùzu query results are closed as they are read** (WP-2.15). `KuzuDriver` never closed a
  `QueryResult`, whose rows live in memory its database owns. When a graph was garbage-collected while
  the process ran on, the database and its last results were finalized in no fixed order, and a result
  freed after its database wrote into freed memory: a segfault, or a corrupted heap that a later,
  unrelated allocation aborted on. It showed as an intermittent native crash in a test process that built and
  dropped several graphs, and it was also why `db.close()` "segfaulted" and was never called. Each result is now closed once read; `close()` refuses
  later queries and closes the connection and then the database once nothing is in flight. Closing the
  database also returns its address-space reservation (8 TB by default), which an unclosed database kept
  until exit, so a process that opened several graphs in turn ran out (`Mmap … failed`).
- **A tool or backend turn that throws inside the in-process loop still fires `task_end`**, once, so every
  processor sees the task end.
- **An in-process writer whose harness leaves out the `security-gate` processor is reviewed.** It was
  reviewed only when its loop threw. The dispatcher now runs the same review right after the loop, once
  per attempt, whichever path reaches it first.
- **`maf run --harness <sha>` naming nothing** says "not found"; it reported that the store's index
  pointed at a missing file, as if the store had been tampered with. A CURRENT that names a tampered or
  missing harness still stops the run, with an error that says CURRENT is at fault and how to repair it.
- **Harness store writes are atomic.** `save`, the index and CURRENT are written to a temporary file and
  renamed into place, so a concurrent run never reads a half-written harness and reports it as tampered,
  and a plain run whose role set has not changed writes nothing (D-39).
- **Every component id names the version it ships as.** The adapter, demo and approval-gate builder ids
  said `@0.1.0`, and `maf --version` printed a literal; both now read the packages' version.
- **`maf goldens run` no longer reads the project's memory graph**: each evaluation runs in its own
  temporary stack (D-14), so a past run's failures cannot leak into the prompt. `maf evolve` still
  evaluates through the project's graph. `evolve`'s smoke check runs the task it names, and on a fresh
  clone `evolve` starts from the same committed default `goldens` evaluates.

### Changed

Behaviour you may notice:

- **Writer roles need `claude`, or `--allow-ungoverned`.** On `codex`, `gemini`, `ollama` or `openrouter`
  a run whose role set holds a writer stops before planning unless the flag is given. Under the flag, an
  HTTP backend cannot change the tree, so `coder` fails with `no_change`.
- **A governed turn passes `--tools ""` to `claude`**; a Claude Code CLI without that flag fails every
  in-process turn.
- **A run works in a worktree.** It no longer changes your checkout or branch, does not see uncommitted
  work, and leaves `.maf/worktrees/<runId>` and the branch `maf/<runId>` behind for you to merge and
  delete. It needs a repository with at least one commit, unless `--no-worktree`.
- **`.maf/config.yaml` (0.2.1 → 0.3.0).** `maf run` now reads `.maf/config.yaml` and stops if it does not
  validate; in 0.2.1 the file was not read and nothing in it had any effect. A file in the shape 0.2.1
  shipped is refused with `unknown key "version"` and `unknown key "defaults"`. To migrate: (1) delete
  `version`; (2) move every key out of `defaults` to the top level and delete `defaults`; (3) delete
  `circuit`, which nothing on the run path reads and which is refused as an unknown key; (4) check the
  values you keep, because they now take effect for the first time. Or delete the file: a run without one
  uses the built-in defaults and prints one line. JSON still loads once the keys are at the top level, and
  the shipped `.maf/config.yaml` is the 0.3.0 form of the defaults. A section whose keys are all commented
  out is empty and stops the run. `-a/--adapter` has no default of its own any more: without it, the file's
  `adapter` applies, else `claude`.
- **`roles.yaml` is YAML.** The JSON form, `#` comment lines included, loads unchanged. Two kinds of JSON
  file no longer load: one that repeats a key within a mapping (the last value used to win) and one with
  bare carriage-return line endings. A merge key (`<<`) is refused. `systemPrompt: ""` is refused, alone or
  beside a `promptFile`: it would now dispatch the empty string rather than fall back to the file. A prompt file that cannot be read stops the run when it starts, not at that
  role's first dispatch.
- **Harnesses.** `legacy-default` is minted again on every plain run, and `maf harness list` shows one
  `legacy-default` row per distinct role set a run minted. CURRENT is either the operator's choice or it
  tracks the roles file: absent, or naming any `legacy-default` snapshot — including one 0.2.x left — it
  moves to each fresh mint. `maf harness set-current` refuses a sha the store does not hold and a
  `legacy-default` snapshot that is not the newest mint (run that one with `--harness <sha>`), and imports a
  committed default before pointing CURRENT at it. A typed `--roles` without `--harness` means that file
  even when CURRENT is set.
- **A role holding `test.run` is a writer** (F10 of the release audit). `test.run` runs the project's own
  code, so a role holding it with only read tools now runs in-process by default and has its diff
  security-reviewed, like any writer; on an adapter that cannot run the loop it needs `--allow-ungoverned`.
- **A CURRENT set before 0.3.0** to a harness other than `legacy-default` names its prompt files without
  their text, so its sha does not cover the prompts that would run. Every plain run is refused while
  CURRENT names it; run `maf harness set-current legacy-default` to hand plain runs back to the roles file,
  or point CURRENT at a harness minted by 0.3.0.
- **`maf goldens`**: results are written as `<harnessSha>.<adapter>.json` (a `<sha>.json` from 0.2.1
  still loads by path or prefix), so a scripted run never overwrites a model's. `goldens compare` exits 2,
  comparing nothing, when a result is missing or malformed or the two were measured on different
  corpora, adapters, models or attempt counts; it exits 1 on a regression and 0 otherwise. `goldens`
  and `evolve` run headless: an escalated tool call is refused.
- **Attestation format.** A 0.3.0 bundle is an in-toto Statement; `Attestor.bundle()` still returns the
  run record with its signature and `keySource`. A 0.2.x bundle still verifies against the key you supply
  and is reported `legacy: true` — only when its 0.2.x signature matched — and a 0.2.1 bundle's
  `keySource` is still enforced. `maf attest verify` without `MAF_SIGNING_KEY` (or with it empty or set to
  the development value) checks against the development key and says so in a note of its own.
- **`maf inprocess-demo`**: its policy now escalates the scripted `fs.delete` rather than denying it, and
  the demo always runs headless, so the call is refused, recorded under the fixture's
  `.maf/approvals/pending/` and in the bundle's `approvals`; it behaves the same offline, unattended and in
  CI. Its bundle is an in-toto Statement with the coder's diff as its subject.
- **Failure records.** A failed node is a `Task` joined to its `Failure`; the post-run loop that wrote one
  bare `Failure` node per failed node is gone. A security refusal still writes its own `Failure` node.
- **The agent's commits** carry the repository's identity, not the host's global one, and are unsigned.
- **Tests:** 22 of the 27 workspace packages now have tests (`@maf/approval-gate` joins), and the
  `@maf/cli` tests drive `maf run` end to end against temporary repositories with the scripted adapter.
  Tests that open the LCM store skip where `better-sqlite3` does not load, and cannot skip in CI. Still
  without tests: `@maf/blackboard`, `@maf/lcm`, `@maf/lcm-adapter`, `@maf/prompt-injector`,
  `@maf/transcript`.

Breaking for code that calls the packages directly:

- `@maf/roles`: `RoleDispatcherConfig` gains `allowUngoverned`, `approvalGate`, `reviewGate` and `stderr`;
  `effectiveTier`, `isWriterForLock` and `harnessRoleSetFromRegistry` are exported; `RoleConfig` gains
  `expectsChange`. A writer that would run on the `cli` tier throws unless `allowUngoverned` is set.
- `@maf/types`: `NodeFailure` reason `no_change`; `ReviewRefused` (extends `GateRefused`);
  `ApprovalAsk`, `ApprovalOutcome`, `ApprovalGateHandle`; `FailureRecorder`, `NodeFailureRecord`;
  `canonicalJson` (moved from `@maf/harness-config`, which re-exports it, unchanged, so no harness sha
  moves).
- `@maf/approval-gate` is rewritten: `createApprovalGate`, `ApprovalProvider` (with `queues` and an
  `asking` callback that starts the timeout), the terminal and headless providers, `approvalRequestHash`.
  `ApprovalTimeoutError`, `ApprovalRejectedError` and `GithubPrReviewer` are removed.
- `@maf/git-ops`: `WorktreeManager` is per run (`createForRun`, `finish` returning a `FinishResult` whose
  `kind` is `merge`, `no-change`, `refused` or `failure`, and `remove`); the per-task API and
  `WorktreeInfo` are gone; `resolveWorkingDir` is new. `ReviewGate.review` takes the diff and a reviewer
  function (`Reviewer`, `ReviewRequest`, `ReviewDecision`); `ReviewResult` is gone. `RollbackManager` takes
  the run's worktree and refuses any reset outside it. `BranchIsolator` has no merge operation.
- `@maf/attestation`: `parseBundle`, `Attestor.report`, `componentId`, `mafVersion`, `DEV_SIGNING_KEY`,
  `MAF_RUN_PREDICATE_TYPE`, `makeInTotoStatement`. `BundleSigner('')` means the development key, as in the
  `Attestor`.
- `@maf/harness-config`: `resolveHarnessRef`, `HarnessStore.configSource`, `LEGACY_DEFAULT_ID`;
  `HarnessStore.setCurrent` refuses as described above; `HarnessConfig` gains `reviewGate`.
- `@maf/dag-runner`: `DagRunnerOptions.failureRecorder` and `failureRecordTimeoutMs`.
  `@maf/memory-graph`: `recallFailures`, and `MemoryGraph` implements `FailureRecorder`.
  `@maf/planning-agent`: every planned node carries `metadata.runTitle`.
- `@maf/policy-engine`: `parseYamlDocument` and `YamlSyntaxError` are exported.
- `@maf/eval-harness`: `ScriptedAdapter`, the judge module, `computeCorpusSha`, `checkUnmodified`.
- `@maf/cli`: `ConfigLoader.load` validates and throws; `MafConfig` lost `circuit`, `policyPath` and
  `dag.timeoutMs` and gained `timeouts`; `resolveConfig` and `applyDagSettings` are new.

### Documentation

- README: the Status table flips to *shipped* every row this release landed, each naming its tests, and
  marks the rows the CI `e2e` job also runs; prose describes the governed default, the approval and review
  gates, worktrees, config precedence and its migration, which harness a run uses, the Claude Code CLI flags
  MAF passes, and what `--no-worktree` gives up. Planned: `allowPartial` from specs or the planner, the
  toolchain floor, Docker, npm; experimental: LCM and the evolver.
- `docs/POLICY.md`, `docs/ROLES.md` and `docs/SECURITY.md` describe the code as of this release: the
  approval gate, the review gate and its construction rules, worktree isolation and what it does not
  separate, the tier default and the backend isolation flags, the agent's git tools and their limits,
  `roles.yaml` as YAML, the dispatch flow, and an `Escalate` rule's `requiresApproval`, which the engine
  does not read.
- `docs/DECISIONS.md` records D-33 to D-40; `docs/BUILD_PLAN.md` records the Phase 2 statuses, WP-2.14 and
  WP-2.15, and the deviations.

## [0.2.1] - 2026-10-08

Correctness fixes from an independent audit of v0.2.0 (2026-10-08) and from the independent review of
this release's branch, and a documentation pass so that the README describes only what ships — its new
Status table marks every feature shipped, experimental or planned. "P0 #n" cites the audit's numbered
findings; the audit is not published in this repository, so every entry says what was wrong. D-28 to
D-31 cite [docs/DECISIONS.md](docs/DECISIONS.md); the D-nn identifiers in the 0.2.0 section refer to an
earlier sweep.

### Security

- **A security-gate rejection can no longer be retried into a pass** (P0 #3). The retry wrapped the whole
  node, gate included, with three attempts by default, and captured the writer's start commit afresh on
  each attempt: a rejected change got a second roll, and if the coder had committed it, attempt 2 diffed
  clean and passed. Only a `TransportError` is retried now (see Fixed for which failures those are); gate
  and policy refusals are `VerdictError`s and end the node. The start commit is captured once per node
  and reused by every attempt.
- **The security gate reviews the whole diff or refuses it** (P0 #4). It sent the first 16,000
  characters to the reviewer and attested the change as reviewed. A diff over the gate's cap
  (`maxDiffChars`, default 60,000 characters) now fails the node with `GateRefused`, naming the size,
  before any model call; the refusal is attested and recorded as a `Failure` node.
- **The gate's verdict comes from finding severities** (P0 #4). `passed` was taken from the reviewer's
  JSON, so a review that reported its own critical finding beside `passed: true` let the change through.
  Any critical or high finding now fails the node and the model's `passed` is ignored; output whose
  severities cannot be read (no findings array, a finding with no recognisable severity) fails closed.
- **Every role that holds a write tool is security-reviewed**, not only the role named `coder` (audit,
  security findings). The default tester holds `patch.apply` and was never reviewed, nor was any custom
  role holding `fs.write` or `git.commit`. A writer is now any role holding `fs.write`, `fs.delete`,
  `patch.apply`, `git.commit`, `git.reset` or `git.add` (`isWriterRole`, exported from `@maf/roles`), on
  the `cli` tier and in the in-process `security-gate` processor alike.
- **A backend that throws is reviewed before the failure propagates** (D-31). When the adapter or the
  in-process loop threw — a timed-out turn, a backend that never started — nothing reviewed what the
  agent had already written: the in-process review runs at `task_end`, which a throw never reaches. The
  dispatcher now runs the gate on the tree before rethrowing; a refusal outranks the original error, and
  a clean or empty diff lets it through for the scheduler to classify.
- **A policy file that cannot be read in full stops the run** (P0 #5). `PolicyEngine.fromYaml` parsed with
  `parseSimpleYaml`, which answered real YAML, a JSON typo or any other failure with zero rules, silently,
  so every Deny and Escalate rule disappeared. Policy now loads through `PolicyLoader` with a real YAML
  parser (the `yaml` package) and schema validation; see Changed for what that means for policy files.
- **Path globs match dotfiles** (P0 #5). minimatch ran without `{ dot: true }`, so `**/secrets/**` did not
  cover `secrets/.hidden` and `**/.env*` did not cover `.config/.env`. A rule whose action kind the engine
  does not know now throws instead of returning `undefined`.
- **Tool writes under `.git/` and `.maf/` are denied by the shipped policy** (audit, security findings).
  A hook written to `.git/hooks/`, or `core.hooksPath` in `.git/config`, runs outside every gate; `.maf/`
  holds the policy, roles and run records an agent could rewrite. New rules `deny-git-dir` and
  `deny-maf-dir`, at priority 1000 for every role, refuse `fs.write`, `fs.delete`, `patch.apply` and
  `git.add` there. `.gitignore`, `.gitattributes` and `.githooks/` stay writable.
- **Model-supplied strings are never read as options** (P0 #7). `grep` passed the pattern as a bare
  argument, so `--pre=sh` was an rg option; both rg and the grep fallback now get `-e <pattern> -- <path>`,
  and the flag values the model picks are bound with `=`. `git.log` built `-${n}` from unchecked input, so
  `n: "-output=/tmp/x"` made git write a file; `n` must now be a positive whole number. `git.reset` passed
  `to` unchecked; it is now matched against a narrow revision pattern and followed by a trailing `--`
  (D-28: not `--end-of-options`, which `git reset` accepts only from git 2.44). The git helper sets
  `GIT_LITERAL_PATHSPECS=1`. `git.diff` declared `paths` to the policy engine but diffed `path`; it now
  declares and diffs one list.
- **The signing key is an explicit choice, and a bundle says which key signed it** (P0 #8). The `Attestor`
  fell back to the public key `'dev-secret'` whenever `MAF_SIGNING_KEY` was unset, without a word. A run
  without the key now prints one warning line to stderr, `run` prints the bundle's `keySource` beside its
  signature, and every bundle carries `keySource: "env" | "dev"` inside the signed payload.
  `Attestor.verify` accepts a bundle only when the signature matches the key *and* the bundle's
  `keySource` names that kind of key, so a bundle re-signed with the development key cannot pass as
  `"env"`; `BundleSigner.verify` applies the same rule, so the exported verifier is not the weaker one.
- **0.2.0 bundles: verify against the key you supply; `inspect` reports `legacy`.** A bundle written
  before `keySource` existed verifies on its signature alone, against whatever key the caller supplies,
  and `Attestor.inspect` returns `legacy: true` for it.
- **Refused tool calls are attested** (P0 #12). `attestor.record` ran only after a tool executed, so a
  Deny, Escalate or Indeterminate verdict left no trace in the signed bundle. Refusals are now recorded,
  with the verdict, the reason and the id of the rule that decided (`Deny` decisions now carry it), before
  `PolicyViolationError` is thrown. The verdict check was a deny-list of three names, which let any other
  verdict fall through to execute; now anything but `Allow` refuses.
- **Failure messages no longer carry credentials.** A failed node's error quotes the end of the backend's
  output, and that error reaches the bundle's run outcome and the memory graph; the tail is now masked
  with the eight credential formats the redactor knows. A backend's stderr tail (in a spawner's
  `TransportError` or a failed in-process turn) and an HTTP error body's tail are masked for bearer
  tokens, `sk-` keys and Google, GitHub and AWS keys.
- **The processor contract catches in-place mutation** (P0 #11). Each processor's output was compared with
  the live input object, so a processor that edited the event in place — swapping `call.toolName` at
  `before_tool`, or rewriting an earlier history message at `before_model` — compared equal to itself and
  passed. Outputs are now checked against a snapshot taken before the processor runs.

### Fixed

- **A failed backend fails the node** (P0 #1). The `cli` tier never read the result's `success` or
  `exitCode`, so a timed-out CLI, an HTTP error body or any other failure was stored as the node's output
  and the node succeeded — on the tier every shipped role runs on. Failures are now split by what they
  say about the work:
  - *Transport failures* — a CLI that timed out (exit 124), exited non-zero without writing to stdout, or
    could not start; an HTTP request that failed, was aborted at its deadline or got a 5xx — are
    `TransportError`s. The node is retried once, then fails. For a CLI the message carries the backend's
    stderr tail, masked; for an HTTP 5xx, the body's tail, masked.
  - *Judged failures* — a CLI that exited non-zero after writing output, an HTTP 4xx such as an expired
    or rejected key — fail the node with a `NodeFailure` and are not retried. The message carries the
    exit code (or HTTP status) and the last 500 characters of the output, masked.
  - A role holding a write tool that returns empty output fails too.
- **An in-process turn that did not finish no longer counts as an answer** (audit, scheduler findings).
  `ClaudeAdapter.sendTurn` and `CodexAdapter.sendTurn` parsed stdout whatever the exit status, so a
  timed-out turn parsed as a final answer with no tool calls and the loop ended `completed`. A turn that
  timed out, or exited non-zero without output, now throws the spawner's `TransportError`; one that exited
  non-zero after writing output throws an `Error` with the exit code and a masked stderr tail.
- **An in-process loop that ran out of budget fails the node** (P0 #2). `budget_exhausted`
  (`maxToolIterations`, `tokenBudget`, or a processor stopping the loop) was returned as success, and a
  test locked that in. It now fails with reason `budget_exhausted`, unless the DAG node sets
  `allowPartial: true`, in which case the node succeeds and returns the reason as its `outcome`. Only a
  DAG built in code can set `allowPartial` in this release: DAG specs, `DagSynthesizer` and the planner
  cannot set it yet (planned for 0.3.0).
- **A reviewer that times out is a transport failure, not a refusal.** A security reviewer that timed
  out, exited non-zero without output, or got an HTTP 5xx was parsed as an unreadable review and refused
  the change, a verdict on work nobody had judged. Its `TransportError` now propagates and the node is
  retried.
- **`maf run` works on a repository with no `.maf/`** (P0 #6). It opened `.maf/lcm.db` and
  `.maf/memory.kuzu` before anything created the directory, and crashed. `run` now creates `.maf/` first.
- **`inprocess-demo` no longer depends on your global git configuration** (P0 #6). The fixture's commit
  ran plain `git`, so a global `commit.gpgsign=true` or a failing global hook broke the demo. It now goes
  through the isolated git helper with `commit.gpgsign=false`.
- **The Claude adapter no longer passes `--max-tokens`** (found by the WP-1.12 fresh-clone proof). The `claude`
  binary has no such flag, so any role with a `tokenBudget` made every `cli`-tier node exit 1 on "unknown option".
  The knob is ignored on that path, as `temperature` already was, and enforced by the in-process loop; the HTTP
  adapters still send it as `max_tokens` / `num_predict`.
- **OpenRouter and Ollama name no model** (P0 #9). They fell back to pinned model ids
  (`anthropic/claude-sonnet-4-6`, `llama3.2`), billing or requesting a model nobody chose. OpenRouter's
  `HTTP-Referer` named `https://github.com/maf`, which is not this project; it now names this repository.
- **`validateDag` refuses a concurrency limit the scheduler cannot use** (P0 #10). `maxConcurrent` was
  tested with `< 1`, which `NaN` and a JSON string pass, and the scheduler then spun forever without
  awaiting. It must now be a positive safe integer, and so must each node's `retryPolicy.maxAttempts`;
  `withRetry` throws a `RangeError` for a policy allowing no attempt, where it used to `throw undefined`.

### Changed

Behaviour you may notice:

- **What `Succeeded` means on the `cli` tier is written down.** The README's "Before `maf run`" list now says
  that the backend keeps its own permissions, MCP servers and hooks — `claude --print` refuses file edits unless
  your Claude Code settings allow them, and starts whatever MCP servers your user-level config names — so a run on a
  fresh machine can report `Succeeded` (the CLI exited 0 with an answer) having changed
  nothing; the attestation's empty diff hashes are the record of that. Making the verdict say it is planned for
  0.3.0 (Status table).
- **Retries:** two attempts by default (was three), everywhere a default was minted — `DagParser`,
  `DagSynthesizer`, the planner, `DEFAULT_NODE_RETRY` — and only transport failures are retried. A CLI
  agent that times out is therefore run a second time, so a node's wall time can reach twice its
  timeout.
- **`OPENROUTER_MODEL` / `OLLAMA_MODEL` are required** for those adapters, unless `--model` or a role's
  `model` names one. With none, the first model call is refused, naming the variable, before anything is
  sent. `maf adapters` still lists both adapters without them.
- **OpenRouter and Ollama throw** a `TransportError` from `invoke` and `stream` for a failed or aborted
  request and for an HTTP 5xx, where they returned `success: false`; a 4xx is still a failed result.
- **A policy file must be valid YAML and pass validation, or the run stops** with the parse or validation
  errors. A missing policy file still runs, with one warning line and no rules. Required on every rule:
  `id` (unique), `priority`, `predicate`, `action`; unknown fields, empty globs and empty lists are
  refused. Globs must be quoted in YAML. JSON policy files still load.
- **`pnpm-lock.yaml`** records `yaml`, the new dependency of `@maf/policy-engine`, so
  `pnpm install --frozen-lockfile` works from a fresh clone.
- **`.maf/policy.yaml`** is now block YAML with comments, its six existing rules unchanged field for field,
  plus `deny-git-dir`, `deny-maf-dir` (see Security) and `tester-no-ci-config` (priority 81, D-30): the
  tester may not write, patch or delete under `.github/`, which `**/*test*` reached once globs matched
  dotfiles.
- **The security diff leaves out this run's runtime state, and nothing else** (D-29). It still covers the
  whole repository, even when `-d` names a subdirectory, but excludes by name what a run writes under
  `<cwd>/.maf/` — `runs/`, `cache/`, `memory.kuzu`, `lcm.db*`, `transcripts/`, `attestations/`,
  `harnesses/`, `goldens/results/`, `evolve/` — because it grows during the run and would push an honest
  diff past the cap. MAF's configuration there (`policy.yaml`, `roles.yaml`, `config.yaml`, `prompts/`)
  is reviewed like any other file.
- **A review that says `passed: false` with only medium, low or info findings now passes**: the
  severities decide, in both directions.
- **A review prompt for a diff between 16,000 and 60,000 characters is now sent whole**, where it was cut
  to 16,000; such reviews cost more and take longer.
- **Golden and evolve attempts whose diff is over the gate's cap now error** instead of being scored on
  a review of the first 16,000 characters.
- **`GateRefused` replaces the gate's plain `Error`** ("Security review failed: N blocking finding(s)"),
  with new message text; anything matching on the old message must change.
- **`git.log`** rejects an `n` that is not a positive whole number, before git runs.
- **`git.add` and `git.diff`** no longer expand globs or pathspec magic: paths are literal.
- **`git.reset`** accepts only a hex object name, `HEAD`, `HEAD~N`, `HEAD^N`, or a branch or tag name that
  does not start with `-`.
- **A run without `MAF_SIGNING_KEY`** prints one warning line to stderr.
- **Every writer role needs a git repository** at the start of its node, since its start commit is now
  captured (before, only `coder`'s was), and a `cli`-tier writer that returns empty output fails.
- **Tests:** 21 of the 27 workspace packages now have tests, the Claude, Codex and Gemini adapters among
  them (run against a stand-in spawner). `scripts/check-test-scripts.mjs` fails if any of those 21 loses
  its tests. Still without tests: `@maf/approval-gate`, `@maf/blackboard`, `@maf/lcm`,
  `@maf/lcm-adapter`, `@maf/prompt-injector`, `@maf/transcript`.

Breaking for code that calls the packages directly:

- `PolicyEngine.fromYaml` and `parseSimpleYaml` are removed. Use `PolicyLoader.load(path)` or
  `PolicyLoader.loadEngine(path, graph)`; `PolicyLoader.validate(rules)` reports schema problems.
- `Attestor`'s fourth constructor argument is a required `{ secret?: string }` (it was an optional string
  defaulting to `MAF_SIGNING_KEY` or `'dev-secret'`); `Attestor.resolveSigningSecret(env)` reads the
  variable and warns. `Attestor.verify(bundle, { secret? })` still returns a boolean, but takes an
  options object where it took a string, and also checks `keySource`. `Attestor.inspect(bundle,
  { secret? })` is new and returns `{ valid, keySource, legacy }`. `AttestationBundle` gains `keySource`.
  `BundleSigner.verify` checks `keySource` too.
- `SecurityReviewGate` takes `maxDiffChars` and throws `GateRefused` for a diff over it, and rethrows a
  reviewer's `TransportError`.
- `withRetry` retries only `TransportError` and throws `RangeError` for `maxAttempts < 1`.
  `DEFAULT_RETRY_POLICY` moved to `@maf/types` (still re-exported by `@maf/dag-runner`).
- New in `@maf/types`: `TransportError` and `VerdictError` (base classes the scheduler classifies by),
  `NodeFailure` with a typed `reason`, `PartialNodeOutcome`, `DagNode.allowPartial`, `GateRefused`,
  `KeySource`, `AdapterInvokeResult.transportError`, and an optional `ruleId` on `Deny` decisions.
  `PolicyViolationError` extends `VerdictError`.
- `spawnAndCollect` marks a timeout or a silent non-zero exit with `transportError` (its message carries
  a masked stderr tail), and a process that cannot start rejects with a `TransportError`.
  `@maf/adapter-base` exports `turnStdout` and `failureTail`.
- `ClaudeAdapter.sendTurn` and `CodexAdapter.sendTurn` throw on a timeout or a non-zero exit. The Claude,
  Codex and Gemini adapters take an optional `{ spawn, spawnStreaming }`. `OpenRouterAdapter` and
  `OllamaAdapter` throw `TransportError` as described above.
- `snapshotDiff` uses the `:(top)` pathspec and excludes `MAF_RUNTIME_STATE` (exported from
  `@maf/git-ops`).
- `RoleDispatcher.endNode(nodeId)` releases a node's cached start commit; call it from the scheduler's
  `onNodeEnd`.

### Documentation

- README: a Status table (shipped / experimental / planned, naming the tests behind each shipped row and
  saying where there are none) follows the summary, and prose describes only shipped rows. Removed or
  corrected: the approval flow for `Escalate`, a human review gate running alongside the security gate,
  in-toto bundles and diff hashes, an offline evaluation harness, `.maf/config.yaml` being read, worktree
  isolation, planner failure recall, "tsc project references" for the build, Ollama and OpenRouter as
  CLIs, and the `dev-secret` signing-key fallback described without its warning or `keySource`.
  Prerequisites now name Node 22, pnpm 8.15.1 through corepack, git, npm, and the native modules.
- `docs/POLICY.md`, `docs/ROLES.md` and `docs/SECURITY.md` describe the code as of this release:
  `Indeterminate`, Escalate refused, the loader's rules, the new default rules, writer roles decided by
  tools held, the start commit as the diff base, the whole-repository diff and its runtime-state
  exclusion, when the review runs (including after a throw), the two different tester definitions, the
  gate's caps, the attested refusals, `keySource` and legacy bundles, which processes see the signing
  key, and `test.run` executing project code.
- `docs/DECISIONS.md` records D-28 to D-31.
- CI: every job has `timeout-minutes: 15`.

## [0.2.0] - 2026-10-08

D-nn identifiers refer to the maintainer's internal defect sweep of 2026-09-25; every entry below is
self-contained.

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

- **Paths are confined to the project root, and one file has one spelling.** Fixes D-11, D-22. All
  five `fs` tools resolved `path.resolve(ctx.cwd, input.path)` and nothing else — `ctx.projectRoot`
  was in the type and read nowhere in `packages/tools/src` — so `../outside.txt`, an absolute path
  and a symlink pointing out were each read *and written* outside the root. `resolveInside(root, p)`
  (`@maf/types`, `packages/types/src/paths.ts`) returns a `ConfinedPath` whose `absolute` is the
  realpath of the target with every symlink followed, checked with a separator-aware prefix against
  the realpath of the root; a dangling symlink is caught by resolving component by component rather
  than only the final path. A path that leaves the root is refused; a symlink that stays inside is
  resolved and allowed.

  The same function is what the **policy engine** now checks, so the checked path and the executed
  path are one value instead of two that could disagree. That disagreement was the defect: minimatch
  was handed the raw string the caller typed, so the shipped `protect-secrets` rule
  (`pathGlob: "**/.env*"`) denied `.env` and *allowed* `./.env`, `a/../.env` and `../.env` — the
  spelling decided whether the rule fired. Confinement runs **before** the rule list and does not
  depend on a rule existing, so an empty policy file does not turn it off; the verdict is `Deny`
  (not `Indeterminate`) and is not escalatable.

  Migration: a `pathGlob`/`allowedPathGlobs` pattern is matched against the resolved root-relative
  path, so a rule that relied on a spelling must rely on the path instead. `allowedPathGlobs`
  behaves the other way round from before in one case worth naming — `./tests/util.ts` used to
  match no allowed glob and be read as "outside the allowed tree", and is now simply `tests/util.ts`.
  `ToolPlugin.declaredPaths` is unchanged; `resolveInside`, `PathEscapeError` and `ConfinedPath` are
  new exports of `@maf/types`. See [docs/POLICY.md](docs/POLICY.md) and
  [docs/SECURITY.md](docs/SECURITY.md).

### Fixed

- Tool inputs are deep-frozen by `executeToolGated` before policy evaluation, so the input the
  policy judged is the input the tool runs on. A tool that rewrote its own input inside `execute`
  threw a `TypeError` instead of choosing its paths after the gate had closed.

- `@maf/types` has tests and a `test` script: the confinement primitive is asserted directly —
  relative traversals, absolute paths, a symlink out, a **dangling** symlink out and a symlink
  cycle are each refused, a link that stays inside resolves, and every spelling of one in-root file
  collapses to that file. The two consumers assert their own halves: the fs tools that a direct
  `execute` cannot escape, and the policy engine that the refusal arrives with no rules loaded.

- `@maf/memory-graph` has tests and a `test` script. The binding guarantee is asserted against a
  **real** Kùzu database (a crafted value round-trips byte-for-byte and the graph is untouched,
  while the same text spliced into the query deletes a row — the anti-vacuity half), and a source
  guard fails if the quote-doubling escaper or a `$name`-substituting `replace` reappears anywhere
  under a package's `src`. Both halves were verified to fail when the defect is put back.

- `run()` **propagates** a query error rather than returning an empty result. The best-effort
  readers that legitimately tolerate a graph failure (`ScoreRecorder`, the planner's lesson
  recall, `querySubgraph`'s edge lookup) now say so in an explicit `try`/`catch` at the point
  where the tolerance is intended.

## [0.1.0] - 2026-09-10

Initial public import — the HarnessX-derived in-process gated loop, harness configs, eval harness
and evolver (tag `v0.1.0`).
