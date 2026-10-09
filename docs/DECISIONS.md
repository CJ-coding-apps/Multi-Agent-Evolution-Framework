# Decisions

Design decisions for MAF, recorded so that contributors — human or agent — build on them rather than re-derive them. One entry per decision: what was decided, why, and what it implies. Entries are numbered for citation in pull requests ("implements D-03"). Status is *decided* unless marked otherwise; an entry is changed by a new entry that supersedes it, never by editing history.

Decided 2026-10-08 by the maintainer, following an independent audit of v0.2.0.

## Execution model

**D-01 · Governed in-process execution is the default for writer roles.** Every guarantee MAF makes — policy verdicts, secret redaction, attested tool calls, processor hooks — exists only on the in-process tier. A role that holds a write tool therefore runs in-process by default. The `cli` tier remains available as an explicit opt-in and prints a visible warning that the run is ungoverned. A writer role whose adapter cannot run in-process refuses to start rather than falling back silently; `--allow-ungoverned` is the override.

**D-02 · Escalate asks a human in the terminal; headless runs deny.** When stdin is a TTY, an `Escalate` verdict prompts for approval. When it is not (CI, scheduled runs), the call is refused and the request is written to `.maf/approvals/pending/<id>.json` for audit. Approval decisions are bound to a hash of the actual request and recorded in the attestation. GitHub pull-request review is not an approval channel in this release.

**D-03 · MAF never modifies the user's branch.** Every run creates a git worktree on a `maf/<runId>` branch and works there. On success MAF prints the merge command; it does not merge. On a gate failure the worktree is kept for inspection. `--no-worktree` runs in place and warns. Rollbacks (`git reset --hard`) are permitted only against the run's own worktree branch.

**D-04 · A node that did not finish did not succeed.** `budget_exhausted` (the node's own `maxTurns` or `tokenBudget`) is a failure with that reason. A DAG node may opt in to `allowPartial: true`. On the `cli` tier, an adapter result with `success: false` or empty output from a writer role fails the node, with the exit code and output tail in the error.

**D-05 · Provider failure is not node failure: fail over, then pause.** Provider errors are classified: transient (retry with backoff), quota or rate limit (fail over to the next entry in the role's `adapters: [primary, fallback, …]` chain, recorded in the attestation), authentication (fail). When the chain is exhausted the run enters `paused` with a checkpoint — DAG state, blackboard, worktree branch — and `maf resume <runId>` continues it, automatically after the provider's retry-after when known, otherwise manually.

**D-06 · Retries are for transport, never for verdicts.** A node is retried only on transport failures (timeout, non-zero exit with no output, network error), at most twice. A security-gate rejection or a policy refusal is terminal. The baseline commit for the security diff is captured once per node, not per attempt.

## Security gate and policy

**D-07 · The security gate reviews the whole diff or fails the node.** A diff above the configured size is a node failure, never a truncated review. `passed` is derived from finding severities alone; the reviewing model's own `passed` boolean is ignored. The gate applies to every role that holds a write tool, not to a role name.

**D-08 · Policy files are YAML, validated, and fail closed.** Policies load through `PolicyLoader` with schema validation (JSON remains valid YAML). A missing file warns and loads no rules. A file that does not parse refuses to run. Path globs match dotfiles (`minimatch` with `dot: true`).

**D-09 · Tool writes to `.git/**` and `.maf/**` are denied by default.** A coder commits through the gated `git.commit` tool, never by writing into `.git/`; a hook written there would execute outside every gate. MAF writes its own transcripts, attestations and harness files through its own code path, not the tool layer, so the rule costs the agent nothing. `.gitignore`, `.gitattributes` and a `.githooks/` directory live outside `.git/` and remain writable.

**D-10 · Child processes get the environment they need and nothing else.** Backend CLIs receive the full environment minus `MAF_*` variables. Tools (`grep`, `patch`, `test.run`) receive an allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`, plus a configurable passthrough). The signing key never reaches an agent-controlled process.

**D-11 · `test.run` executes project code and says so.** It is bounded — runner allowlist, arguments after `--`, process-group kill on timeout, a timeout ceiling, the minimal environment — and SECURITY.md states plainly that it runs the project's own tests, which the tester role may have written.

**D-12 · Model-supplied strings are never parsed as options.** `grep` passes the pattern as `-e <pattern> --`; `git.log` validates `n` as a positive safe integer; `git.reset` uses `--end-of-options`; the git helper sets `GIT_LITERAL_PATHSPECS=1`.

## Evidence

**D-13 · Attestations are in-toto Statements over canonical JSON.** The bundle is a real in-toto Statement signed (HMAC) over a canonical form so that a third party can reproduce the bytes. Refused tool calls are recorded. The bundle carries `keySource: "env" | "dev"`; running with the development key prints a loud warning and is never mistaken for a real signature.

**D-14 · Evaluation is offline, isolated and reproducible.** `goldens run --adapter scripted` runs without a model. A default harness and a baseline result are committed. Results record the corpus sha, the attempt count and the adapter. Each evaluation uses a fresh in-memory graph so past runs cannot leak into the prompt. The judge uses a different role or model than the agent when one is available and discloses when it does not.

**D-15 · The evolver only proposes edits that can take effect, and pays only after the gate.** Edits that cannot affect a role's configured tier are rejected at proposal time with the reason. Screening and structural checks run before any evaluation spend. The smoke test runs the target task. Sensitive edits are stored as candidates and shipped with `maf evolve approve <id>`.

**D-16 · The planner's failure recall matches the schema it queries.** Task and Failure nodes are written when a node fails; `CAUSED_FAILURE` is a `relation` value on `MemoryEdge`; the recall query is tested against a real Kùzu database.

## Components

**D-17 · The LCM context engine is built, not stubbed.** Summaries come from the run's adapter (model configurable, counted against the budget); both modes are implemented; the fresh tail is newest-first; compaction summarizes the entries it drops; ghost cues reach the injector; the `lcm` section of `config.yaml` is read. Until this ships, the README lists LCM as experimental.

**D-18 · Existing components are wired, not removed.** `ToolLoop`/`PatchTestCycle`/`CircuitBreaker`/`RollbackManager` become the opt-in `--strategy patch-test` coder strategy. `BlackboardSqlitePersistence`/`BlackboardValidator`/`FlushOnSnapshot` provide run persistence, which is the checkpoint D-05 relies on. `DagSynthesizer` backs `--plan-from <spec>`. `FailurePatternDetector` serves D-16. The LCM operators serve D-17. `SubgraphQuery`/`RunMerger` are consolidated with the duplicate methods on `MemoryGraph` into one implementation. Every wired component gets tests and a README status row.

**D-19 · `maf harness import` exists; `maf knowledge sync` does not.** The first is implemented (validate, copy, index). References to the second are removed.

**D-20 · Kùzu is pinned to 0.11.3, the final release, everywhere.** The Node binding moves from 0.7.1 to exactly 0.11.3 behind `maf graph export` / `maf graph import`; an old-format database is refused with instructions. The prebuilt binary must install on the maintainer's platforms with Node 22 before the bump lands; a source build is not an acceptable install path.

**D-21 · Toolchain floor: Node 22, pnpm 10.** `engines` declares Node ≥ 22. pnpm 10 with `onlyBuiltDependencies` for `kuzu` and `better-sqlite3`; lockfile v9. Native prerequisites are documented in the README.

## Process

**D-22 · Releases: 0.2.1, then 0.3.0, then 0.4.0.** 0.2.1 carries the correctness fixes and the documentation truth pass. 0.3.0 carries D-01 through D-03, D-08, D-13, D-14, D-16 and D-19. 0.4.0 carries D-05, D-15, D-17, D-18, D-20 and hardening.

**D-23 · The README describes shipped behaviour only.** A Status table (shipped / experimental / planned) is the first section after the summary. A claim appears as prose only when its row says shipped. The documentation pass runs last in each release so it matches what landed.

**D-24 · CI proves what the README demonstrates.** Every job has `timeout-minutes`. An end-to-end job runs `inprocess-demo` and the offline goldens against a real Kùzu database. Live-model validation runs nightly with a daily cap; credentials exist only in that job.

**D-25 · A change ships with the test that would have caught it.** Each pull request that closes an audit finding carries the regression test for it. Adapters are tested against fake CLI binaries on `PATH`. No package the CLI depends on may be without tests.

**D-26 · Pull requests are small and package-confined; integration is reviewed by the maintainer.** One PR per decision or audit item group, under roughly four hundred changed lines, rebased on `main` daily. Package-confined PRs may be merged by the implementing agent when CI is green and an independent verifier has passed them. PRs touching `run.ts`, `RoleDispatcher.ts`, `wiring.ts`, workflow files, or versions require the maintainer.

**D-27 · Agents stop and ask** before changing behaviour the README describes, adding a dependency, editing a workflow file, refactoring beyond the task, or crossing a phase boundary. Releases, tags, repository settings and visibility are the maintainer's.

## Added during Phase 1 integration (2026-10-08)

**D-28 · `git.reset` ends its argv with `--`, not `--end-of-options`.** Supersedes the second clause of D-12 for `reset` only. `git reset` accepts `--end-of-options` only from git 2.44; the trailing separator makes git read the checked revision as a revision on every supported git, and the revision pattern already refuses anything that starts with `-`.

**D-29 · The security diff is the whole repository minus this run's runtime state.** The reviewed diff is taken with the `:(top)` pathspec — the full tree, however deep inside the repository MAF was pointed — and excludes only the entries under `<cwd>/.maf/` that a run produces (the `.gitignore` "runtime state" list: `runs/`, `cache/`, `memory.kuzu`, `lcm.db*`, `transcripts/`, `attestations/`, `harnesses/`, `goldens/results/`, `evolve/`). MAF's configuration under `.maf/` — `policy.yaml`, `roles.yaml`, `config.yaml`, `prompts/` — is content an agent could rewrite to shape the next run, and stays in the diff. Runtime state is excluded because it grows during the run, is written by MAF rather than the agent, and would push an honest diff past the gate's cap (D-07) in a repository that does not ignore it.

**D-30 · A tester may not write CI configuration.** Globs match dotfiles (D-08), so the tester's `**/*test*` allow-list reached `.github/workflows/test.yml`. The shipped policy denies the tester writes under `.github/` at a priority above its allow-list. A workflow file is CI configuration, not a test.

**D-31 · A backend that throws is reviewed before the failure propagates.** When the adapter or the in-process loop throws (a timed-out turn, a backend that never started), the dispatcher runs the security gate on whatever the agent left in the tree before rethrowing: a gate refusal (a verdict) outranks the transport failure; a clean or empty diff lets the original error through for the scheduler to classify (D-06). On the in-process tier the gate otherwise runs at `task_end`, which a throw never reaches.

**D-32 · A role says whether it is expected to change the tree.** A writer-role node on the `cli` tier can exit 0 with an answer and leave the tree untouched — a backend running under the user's own permission settings refuses the edit and says so — and D-04 reads that as a success. Each role now carries `expectsChange`; a node whose role expects a change and whose diff against the start commit is empty fails with `NodeFailure('no_change')`, the output tail in the error. In the built-in set only `coder` expects a change: `tester` holds `patch.apply` and legitimately changes nothing on most runs, and `security` and `reviewer` hold no write tool. A custom role declares its own expectation. Chosen over a blanket rule with a per-node opt-out (which would make the common tester run a failure to be waived) and over leaving the verdict as is with a `changed: false` beside it (which keeps `Succeeded` meaning two things). Ships in 0.3.0 (WP-2.1).

## Added during Phase 2 integration (2026-10-09)

**D-33 · An in-process turn spawns its backend with native tools off.** The governed loop's only tools are MAF's. For Claude, `sendTurn` passes `--tools ""` beside the strict-MCP flags, in one documented constant; the cli tier keeps the backend's native tools and isolates only MCP. Codex has no known equivalent and keeps `inProcessLoop` off. Found by the WP-2.1 verifier: under D-01 every writer on Claude ran through `sendTurn`, whose `claude --print` still had Claude Code's own tools.

**D-34 · The review gate exists only when asked for.** `run` constructs it when the harness requires review or the operator passes `--review`; an advisory gate so constructed makes each writer node wait for the decision, bounded by the gate's timeout. A required review with no reviewer available (stdin not a TTY, or `MAF_HEADLESS=1`) refuses every writer change — fail closed. `--review` with no reviewer available prints one line and runs without a gate. Chosen over "advisory does not wait" (which needs a drain before the bundle that a forgotten call would silently skip) and over constructing a reviewer whenever stdin is a TTY (which would hold every default run on a human).

**D-35 · The worktree directory is not runtime state.** `MAF_RUNTIME_STATE` keeps D-29's list; `.maf/worktrees/` stays out of the parent's diff through its own `.gitignore`, so adding it to the list only widened the unreviewed set. A run branch that commits runtime state gets no merge command: `finish` refuses and names the paths.

**D-36 · The attestation signs RFC 8785 bytes.** A dedicated serializer in `@maf/attestation` (`jcs.ts`: keys sorted by UTF-16 code units, numbers per `Number::toString`, §3.2.2.2 escapes) produces the signed bytes and is what `maf attest verify` recomputes. `canonicalJson` in `@maf/types` keeps its 0.2.x behaviour (integer-like keys first, `__proto__` dropped) so no harness sha moves, and its comment says it is not RFC 8785. The approval gate hashes requests with its own stricter serializer (refuses NaN, undefined and Date), kept on purpose: a request hash must fail loudly on a value that cannot round-trip.

**D-37 · Failure recall keys on the run title.** Every planned node carries `metadata.runTitle`; the recorder stores it on the Task; recall matches the title's first three words, as one phrase and ignoring case, against the Task's label or properties with bound parameters. The recorder wait is bounded (10 s, unref'd) so a hung recorder cannot hold the run or the bundle.

**D-38 · `goldens compare` compares like with like.** Results that differ in adapter, model or attempt count are refused (exit 2); result files are validated on load and named `<harnessSha>.<adapter>.json`; a missing or malformed file exits 2, a rejection exits 1.

**D-39 · Reserved harness ids, honest CURRENT, safe writes.** `harness import` refuses `legacy-default`, `current` and `CURRENT`; `set-current` refuses a `legacy-default` snapshot that is not the newest mint (pin one with `--harness <sha>`); `adoptLegacy` rewrites nothing that already verifies and every store write goes through a temp file and `rename`, so a concurrent reader never sees a half-written harness.

**D-40 · A YAML merge key is refused.** `parseYamlDocument` (config and roles files) refuses a `<<` key at any depth, naming the file and line. YAML 1.2 has no merge; silently keeping `<<` as a literal key dropped the merged fields without a word. Write the keys out in full.
