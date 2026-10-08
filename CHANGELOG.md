# Changelog

Notable changes to maf. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

maf is pre-1.0 with no known outside users, so breaking changes land in the unreleased section
rather than behind a major bump. They are still listed as breaking, because a reader of this file
is entitled to know which of their own code stops compiling.

## [Unreleased]

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
