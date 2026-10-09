# MAF build plan

The campaign that takes MAF from v0.2.0 to a codebase whose README is true. This file is the fleet's working document: the architect dispatches from it, implementers cite it, verifiers check against it, and the maintainer approves at the gates it names. It is paired with [DECISIONS.md](DECISIONS.md) (the "why", cited as D-nn) and is the record of "what, in what order, done when".

Baseline: v0.2.0 at `a475568`, audited 2026-10-08. The audit's findings are the backlog; each work package below names the findings it closes.

Status legend for work packages: `todo` · `in-progress` · `in-review` · `merged`. The architect updates this file in the same PR that changes a package's status.

---

## 1. Goals and exit criteria

**Goal.** Every claim the README makes is true of the code, proven by a check that fails when it stops being true.

**Exit criteria (all three required):**

1. Every row the README Status table marks *shipped* has a test or CI job that fails if that behaviour regresses.
2. A fresh clone on a clean machine passes: install → build → test → `inprocess-demo` → `run` against a repository that has no `.maf/` folder.
3. An independent verifier that has not seen the implementation audits README and docs against the code and reports nothing.

**Non-goals for this campaign.** npm publication; multi-platform Docker; a container sandbox for `test.run`; GitHub-PR approval channel (D-02 defers it).

---

## 2. Releases

| Release | Carries | Exit |
|---|---|---|
| **0.2.1** | Correctness fixes (P0) and the documentation truth pass. No behaviour the README describes changes; the README changes to match the code. | Fresh-clone proof; README Status table honest as of the commit. |
| **0.3.0** | The governed-by-default execution model and the wirings: in-process default, approval, review gate, worktrees, YAML/config, planner recall, offline goldens, in-toto attestation, harness import. Toolchain floor. | e2e CI job green; every 0.3.0 Status row shipped with a regression check. |
| **0.4.0** | LCM built properly, patch-test strategy, run persistence with pause/resume, provider failover, DAG-from-spec, evolver as claimed, Kùzu 0.11.3, hardening, consolidation. | Exit criteria 1–3 of §1. |
| **0.5.0** | Port from maf-v1: `mcp-tools` bridge (with its known fixes), `resolveHarnessForRun`, encryption at rest (E1), prompt-injector test script. Scoped after 0.4.0 from the v1 checklist. | — |

Semantics: pre-1.0 SemVer. Behaviour changes bump the minor; 0.2.1 is the only patch release because it changes no documented behaviour.

---

## 3. How the fleet works

### 3.1 Roles

- **Architect** (one, strongest model): turns each work package below into a one-page spec — acceptance test first, then files, then steps — before any implementer starts; owns this file and `DECISIONS.md`; reviews every PR description for a D-nn citation; runs the integration PRs on the maintainer's machine.
- **Implementers** (4–6, model per §3.4): one work package at a time, confined to the package(s) the WP names, in their own git worktree and branch.
- **Verifier** (one per PR, strongest model, fresh context): receives the spec, the diff, and a clean checkout — never the implementer's conversation. Runs the tests, then tries to break the change with inputs the spec names and ones it invents. Reports pass/fail with evidence. A PR is not mergeable without a verifier pass.
- **Maintainer** (CJ): approves `DECISIONS.md`, the integration PRs (§3.3), releases, and any stop-and-ask.

### 3.2 Branch and PR rules

- Branch from `main`, named `wp/<id>-<slug>` (e.g. `wp/1.4-security-gate`). Rebase on `main` daily.
- One work package per PR, under ~400 changed lines excluding tests and lockfiles. Larger WPs are split where this file says so.
- PR title: `<type>(<package>): <summary> [WP-x.y, D-nn]`. PR body: the spec's acceptance test, what changed, what was verified, what was deliberately not done.
- Every PR that closes an audit finding carries the regression test that would have caught it (D-25).
- Merge: package-confined PRs are merged (merge commit) by the implementing session once CI is green and the verifier has passed. Integration PRs — anything touching `packages/cli/src/commands/run.ts`, `packages/cli/src/wiring.ts`, `packages/roles/src/RoleDispatcher.ts`, `.github/workflows/*`, any `package.json` version, or `pnpm-lock.yaml` beyond a mechanical bump — are merged by the maintainer only (D-26).
- No pushes to `main` outside PRs; no force-push; no tags, Releases, repository settings or visibility changes by agents (D-27).

### 3.3 Stop-and-ask conditions (D-27)

An agent stops and reports — it does not proceed, retry another route, or "fix it while in there" — when it would: change behaviour the README describes beyond its WP; add or upgrade a dependency not named in its WP; edit a workflow file outside WP-1.11/2.10/3.10; refactor outside the files its WP names; hit its budget cap (§3.5); or reach a phase boundary.

### 3.4 Model allocation

- Strongest model (Opus-class): architect; verifier; any WP marked **[core]** below.
- Mid model (Sonnet-class): WPs marked **[mech]** — mechanical fixes, docs, test scaffolding, version bumps.
- No model switch mid-PR to stay under budget; stop and report instead.

### 3.5 Budgets

- Per-PR implementer cap: **$15 [mech] · $50 standard · $100 [core] integration**. Report at 75%; stop at the cap.
- Live-model validation: nightly job only, **$50/day**, **$150** on the weekly evolve night. No provider key in any implementer context (D-24).
- One API key per role, each in its own Console workspace with a monthly spend limit: implementers ~$3,500, architect + verifiers ~$1,000, nightly validation ~$750.

### 3.6 Reporting

End of every WP: merge SHA, CI run id, verifier verdict, the acceptance test's name, and anything deliberately not done. End of every day: this file's status column updated in a docs-only commit on the architect's branch.

---

## 4. Lanes

Work packages are grouped into lanes that can run in parallel because they touch disjoint packages. Integration points are serialized at the end of each phase.

```
Phase 1 (0.2.1)
  Lane A  roles · dag-runner · processors            WP-1.2  WP-1.3  WP-1.10
  Lane B  git-ops · policy-engine                    WP-1.4  WP-1.5
  Lane C  tools · attestation · adapters             WP-1.6  WP-1.7  WP-1.8
  Lane D  cli (small, no wiring changes)             WP-1.9
  Serial  WP-1.0 → (lanes) → WP-1.11 → WP-1.12 → release

Phase 2 (0.3.0)
  Lane A  roles (tier default, writer lock)          WP-2.1
  Lane B  approval-gate · review gate                WP-2.2  WP-2.3
  Lane C  git-ops (worktrees)                        WP-2.4
  Lane D  policy-engine · harness-config (config)    WP-2.5  WP-2.9
  Lane E  memory-graph · planning-agent              WP-2.6
  Lane F  eval-harness · attestation                 WP-2.7  WP-2.8
  Lane G  toolchain                                  WP-2.11
  Serial  WP-2.10 (run.ts/wiring.ts integration) → WP-2.12 (CI e2e) → WP-2.13 (docs) → release

Phase 3 (0.4.0)
  Lane A  lcm · lcm-adapter                          WP-3.1
  Lane B  blackboard · dag-runner (persistence)      WP-3.2
  Lane C  adapters (failover)                        WP-3.3
  Lane D  tool-loop · git-ops (patch-test)           WP-3.4
  Lane E  planning-agent (DAG-from-spec)             WP-3.5
  Lane F  evolver                                    WP-3.6
  Lane G  memory-graph (Kùzu 0.11.3, consolidation)  WP-3.7  WP-3.9
  Lane H  hardening across tools/adapters            WP-3.8
  Serial  WP-3.10 (pause/resume + failover into run) → WP-3.11 (tests/CI/nightly) → WP-3.12 (docs, exit audit) → release
```

---

## 5. Phase 1 — release 0.2.1

> **Deviation recorded 2026-10-08:** Phase 1 shipped as one integration branch (`wp/phase-1`: the nine WP branches merged, an integration commit, verifier fixes, docs, version bump) rather than nine package PRs, because WP-1.2, 1.3 and 1.4 overlap in `RoleDispatcher.ts`. Review it commit by commit. An independent verifier audited the merged diff; its findings F1–F17 were fixed on the branch (see `docs/DECISIONS.md` D-28–D-31 and CHANGELOG `[0.2.1]`). The lockfile entry for `yaml` (F1) is added on the maintainer's machine before the PR opens.

### WP-1.0 Decisions file — `in-review` [mech]
Add `docs/DECISIONS.md` and this file. Nothing else in the PR. Maintainer merges.

### WP-1.1 Baseline runtime proof — `in-review` [mech, read-only]
On the maintainer's machine, before any fix: fresh clone of `main` into a temp dir → `corepack pnpm@8.15.1` → `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -r test` (record the case count) → `node packages/cli/dist/main.js --version` → `inprocess-demo` (default, offline) → `run "add a hello function" -d <temp repo with no .maf/> --adapter claude` (record the exact failure) → `claude --help | grep -c max-tokens`. Report verbatim. Changes nothing. This is the "before" for the release notes.

### WP-1.2 Node outcome honesty — `in-review` [core] · D-04 · audit §scheduler 1, 2
**Files:** `packages/roles/src/RoleDispatcher.ts` (~131, ~205), `packages/roles/src/__tests__/RoleDispatcher.test.ts` (266–280 currently locks in the wrong behaviour), `packages/types/src/index.ts` (RunOutcome reason).
**Acceptance:** a stub adapter returning `{success:false, exitCode:124}` fails the node with the exit code and output tail in the error; a writer role returning empty output fails; an in-process loop ending `budget_exhausted` fails with reason `budget_exhausted`; a node declaring `allowPartial: true` succeeds with the reason recorded in the outcome.
**Steps:** read `result.success`/`exitCode` on the CLI tier; throw with a typed `NodeFailure` carrying reason; treat `budget_exhausted` as failure unless `allowPartial`; rewrite the test that asserts the old behaviour; add the four acceptance tests.

### WP-1.3 Retry classification and scheduler guards — `in-review` [core] · D-06 · audit §scheduler 3, 7, 16
**Files:** `packages/dag-runner/src/{DagRunner.ts,RetryOrchestrator.ts,validateDag.ts}`, `packages/types/src/index.ts` (error classes), `packages/adapters/base/src/ProcessSpawner.ts`.
**Acceptance:** a node whose executor throws `GateRefused` or `PolicyViolationError` is not retried; a node whose adapter reports a transport failure (timeout / non-zero exit with no output / network error) is retried once (`maxAttempts` default 2); `validateDag` rejects `maxConcurrent` that is not a positive safe integer; `startCommit` is captured once per node (cache keyed by runId+nodeId in `RoleDispatcher`, cleared on node end).
**Steps:** define `TransportError` and `VerdictError` (base classes) in `@maf/types`; adapters and `ProcessSpawner` raise/return `TransportError`; `withRetry` retries only `TransportError`; default policy `maxAttempts: 2`; guard in `validateDag`; cache the baseline commit; tests for each, including a retry test with a sibling node still running (the race path at `DagRunner.ts:70-72`).

### WP-1.4 Security gate as documented — `in-review` [core] · D-07 · audit §security 26–28, §scheduler 4
**Files:** `packages/git-ops/src/SecurityReviewGate.ts` (25, 54–78), `packages/git-ops/src/__tests__/SecurityReviewGate.gate.test.ts` (56 locks in truncation), `packages/roles/src/RoleDispatcher.ts` (`runPostCoderGates`, role check at 79/243), `packages/roles/src/isWriterRole.ts` (new).
**Acceptance:** a diff over the configured cap (default 60,000 chars) fails the node with a `GateRefused` error naming the size — it is never truncated; `{passed:true, findings:[{severity:'critical'}]}` from the model is a block; `{passed:false, findings:[]}` is a pass (severities decide, the boolean is ignored); the gate runs for any role whose allowed tools include a write tool (`fs.write`, `fs.delete`, `patch.apply`, `git.commit`, `git.reset`, `git.add`), including `tester` and custom roles; a refused gate is `VerdictError` (never retried, per WP-1.3).

### WP-1.5 Policy loads safely and denies the repository's own machinery — `in-review` [core] · D-08, D-09 · audit §security 11, 14; §quickstart 5, 8
**Files:** `packages/policy-engine/src/{PolicyEngine.ts,PolicyLoader.ts}`, `packages/policy-engine/package.json` (+`yaml`), `.maf/policy.yaml`, `packages/cli/src/commands/run.ts` (call site only: `fromYaml` → loader; no other change), `packages/cli/src/wiring.ts` (same).
**Acceptance:** a real-YAML policy file loads its rules; a missing file logs one warning and loads zero rules; an unparseable file or one failing schema validation refuses to start with the parse error; `**/secrets/**` matches `secrets/.hidden` (`dot: true`); the shipped default policy denies tool writes under `.git/**` and `.maf/**` for every role, and a test proves `fs.write .git/hooks/pre-commit` is refused while `.gitignore` is allowed.
**Note:** adding the `yaml` dependency is in scope here and nowhere else; `eval('import("yaml")')` goes.

### WP-1.6 Tool arguments are never options — `in-review` [mech] · D-12 · audit §security 3–7
**Files:** `packages/tools/src/plugins/{grep.ts,git.ts}`, `packages/tools/src/git.ts` helper (env), tests under `packages/tools/src/__tests__/`.
**Acceptance:** `grep` with pattern `--pre=sh` searches for the literal string (args are `-e <pattern> -- <path>` for both `rg` and `grep`); `git.log` with `n: "--output=/tmp/x"` is rejected before spawning; `git.reset` passes `--end-of-options` before `to`; the git helper sets `GIT_LITERAL_PATHSPECS=1`; `git.diff` declares and executes the same field (`paths`). Tests assert the argv built, using a spawn spy; one test runs real `rg` when present.

### WP-1.7 Attestation records refusals and its key source — `in-review` [mech] · D-13 (part 1) · audit §security 21; §scheduler 14
**Files:** `packages/attestation/src/Attestor.ts`, `packages/tool-loop/src/gatedExec.ts` (record after verdict, before/after execute), `packages/cli/src/commands/run.ts` and `wiring.ts` (pass the secret explicitly, warn when unset — call-site lines only).
**Acceptance:** a Deny/Escalate/Indeterminate call appears in the bundle with its verdict; the bundle carries `keySource: "env" | "dev"`; a run without `MAF_SIGNING_KEY` prints one unmistakable warning line; `verify` still passes on a dev-signed bundle and reports `keySource`.

### WP-1.8 Adapters name no model — `in-review` [mech] · audit §models
**Files:** `packages/adapters/openrouter/src/OpenRouterAdapter.ts` (30, 34), `packages/adapters/ollama/src/OllamaAdapter.ts` (40), first tests for both under `packages/adapters/*/src/__tests__/` with a stubbed `fetch`, `check-test-scripts` updated so these packages are now required to have tests.
**Acceptance:** constructing either adapter with no model in options or env and calling `invoke` raises an error naming the env var (`OPENROUTER_MODEL`, `OLLAMA_MODEL`) — nothing is sent; with a model set, the request body carries it; `HTTP-Referer` is this repository's URL.

### WP-1.9 `run` and the demo stand up on their own — `in-review` [mech] · audit §quickstart 1, 2
**Files:** `packages/cli/src/commands/run.ts` (one `mkdir -p .maf` before any store opens — no other change to this file in Phase 1), `packages/cli/src/commands/inprocessDemo.ts` (104–109: fixture commit through `runIsolatedGit`), `packages/cli/src/ensureMafDir.ts` (new, tested).
**Acceptance:** `run` against a temp repository with no `.maf/` proceeds past store construction (unit test on `ensureMafDir`; the end-to-end proof is WP-1.12); the demo's fixture commit succeeds with a global git config that sets `commit.gpgsign=true` (test sets `GIT_CONFIG_GLOBAL` to a file with that key).

### WP-1.10 Processor contract catches in-place mutation — `in-review` [mech] · audit §scheduler 5
**Files:** `packages/processors/src/ProcessorPipeline.ts` (80–83), `packages/processors/src/__tests__/pipeline.test.ts`.
**Acceptance:** a processor that mutates `event.call.toolName` in place and yields the same object throws `ContractViolation`; rewriting an earlier history message in place throws; the existing copy-mutation tests still pass.

### WP-1.11 Documentation truth pass — `in-review` [mech, maintainer merges] · D-23, D-24 (timeouts) · audit §docs
**Files:** `README.md`, `docs/{POLICY,ROLES,SECURITY}.md`, `CHANGELOG.md`, `.github/workflows/ci.yml` (`timeout-minutes: 15` on every job, nothing else), `scripts/check-test-scripts.mjs` (stale header comment).
**Content:** H1 "MAF — Multi-Agent Evolution Framework"; a **Status** table immediately after the summary with one row per claim — approval gate, human review gate, worktree isolation, `config.yaml`, LCM, planner failure recall, offline evaluation harness, in-toto attestation, Docker, npm — marked *experimental* or *planned* as of this commit, with the release that ships each (from §2); prose rewritten so it describes only *shipped* rows; `maf knowledge sync` and `maf harness import` references removed (import returns in 0.3.0); POLICY.md: Escalate is refused today, `Indeterminate` added to the verdict table, `ToolLoop` references removed; ROLES.md: tester has `fs.write`, diff base is the start commit; SECURITY.md: "currently 0.2.1", the truncation sentence now true (WP-1.4), `test.run` executes project code; README prerequisites: Node ≥ 22 for CI, native modules (`kuzu`, `better-sqlite3`), `git`, `npm`, `playwright` not required; "tsc project references" → per-package `tsc`; Ollama/OpenRouter are HTTP adapters; CHANGELOG `[0.2.1]` listing WP-1.2…1.10 by audit finding.
**Acceptance:** `check-doc-refs` passes; a verifier reads README top to bottom against `main` and finds no sentence that is false.

### WP-1.12 Fresh-clone proof and release — `in-review` (proof done on the branch tip; repeat on merged `main`, then Release) [mech]
Repeat WP-1.1 on merged `main`. `run` on a repo without `.maf/` must now reach the adapter. Report before/after side by side. Maintainer creates Release `v0.2.1` with notes drawn from the CHANGELOG section plus the before/after.

Proof on `wp/phase-1` (2026-10-08, macOS, Node 25, pnpm 8.15.1): install/build clean, 462 tests · 461 pass · 0 fail · 1 skipped, `--version` 0.2.1, demo end-to-end offline; `run` on a repo with no `.maf/` created `.maf/`, planned, executed and wrote a signed bundle where 0.2.0 died at `Cannot open database`. Two things it surfaced: (1) `claude --help | grep -c max-tokens` → 0, yet the adapter passed `--max-tokens` for any role with a `tokenBudget` — fixed on the branch, the knob is now ignored on the cli tier like temperature; (2) with the real `claude` backend both agents reported they could not write (`claude --print` runs with the user's own permission settings) and MAF attested every node `Succeeded` with empty diff hashes. (2) is the documented cli-tier contract, now stated in the README; the mechanism that makes the verdict say it is a Phase 2 decision (see WP-2.1).

---

## 6. Phase 2 — release 0.3.0

### WP-2.1 In-process by default for writer roles — `todo` [core] · D-01 · audit §scheduler 10, 11
**Carried from WP-1.12, decided 2026-10-08 (D-32):** a writer-role node on the `cli` tier whose tree diff is empty after a non-empty, exit-0 answer fails with `NodeFailure('no_change')` when its role sets `expectsChange`; `coder` is the only built-in role that does. Add to this WP's acceptance: a `coder` node whose backend exits 0 with an answer and no diff fails `no_change`; the same for `tester` succeeds; a custom role with `expectsChange: true` behaves as `coder`; the diff is the one the security gate already takes (D-29), so the start commit is captured once (D-06). Update `docs/ROLES.md`'s field table and the README Status row planned for 0.3.0.

**Also carried from WP-1.12 (cli-tier hardening, this WP or WP-2.4):** the spawned backend inherits the user's whole Claude Code configuration — MCP servers and hooks included, observed as a third-party MCP server's dashboard opening once per spawn during the proof. Spawn `claude` with its strict-MCP flag and an empty server list so the backend gets no MCP servers unless MAF hands them over (confirm the flag with `claude --help`; the codex and gemini adapters need the equivalent check), and say so in the README's "Before `maf run`" list.
**Files:** `packages/roles/src/{RoleRegistry.ts,RoleDispatcher.ts}`, `.maf/roles.yaml`, `packages/cli/src/commands/run.ts` (`--allow-ungoverned` flag; writer-lock computed from the *effective* tier — integration, lands in WP-2.10).
**Acceptance:** with no `execution` set, a role holding a write tool resolves to `in-process`; a writer role on an adapter without `inProcessLoop` refuses to start with a message naming `--allow-ungoverned`; with the flag, it runs `cli` and prints the ungoverned banner once; the writer lock counts a role by its effective tier, so a read-only in-process role that fell back to `cli` is treated as a writer; tool or adapter exceptions in the loop still fire `task_end` (audit §scheduler 11).

### WP-2.2 Approval gate wired — `todo` [core] · D-02 · audit §scheduler 17, 18
**Files:** `packages/approval-gate/src/ApprovalGate.ts`, new `packages/approval-gate/src/providers/{tty.ts,headless.ts}`, `packages/tool-loop/src/gatedExec.ts` (Escalate path), `packages/attestation/src/Attestor.ts` (`addApproval` called), first tests for the package.
**Acceptance:** Escalate on a TTY prompts with tool id, declared paths and the request hash, and an approval lets the call execute once; a decision is bound to the request hash and a mismatched hash is refused; request ids are unique and cannot be reused; timeout denies and clears the slot; headless (stdin not a TTY) denies and writes `.maf/approvals/pending/<id>.json`; every decision appears in the attestation; the PR-merged-means-approved path is removed or behind an explicit, documented option that is off.

### WP-2.3 Human review gate wired — `todo` [core] · audit §quickstart 7; §eval 34
**Files:** `packages/git-ops/src/ReviewGate.ts` (28: fail-open on diff read error → fail closed), `packages/roles/src/RoleDispatcher.ts` (`reviewGate` read; runs alongside the security gate for writer roles), harness `reviewGate: { required: boolean }`.
**Acceptance:** with `required: true`, a writer node blocks until the review decision; with `required: false` (default), the review request and outcome are recorded and the run continues; an error reading the diff fails the gate; the review runs for the same roles as the security gate.

### WP-2.4 Worktree isolation — `todo` [core] · D-03 · audit §quickstart 9; §security 29–31
**Files:** `packages/git-ops/src/{WorktreeManager.ts,BranchIsolator.ts,RollbackManager.ts}`, `packages/cli/src/commands/run.ts` (integration in WP-2.10), tests with real git.
**Acceptance:** a run creates worktree `.maf/worktrees/<runId>` on branch `maf/<runId>` from the current HEAD and every adapter/tool runs with that cwd; on success MAF prints `git merge maf/<runId>` and does not merge; on gate failure the worktree remains and its path is printed; `--no-worktree` runs in place after a warning; `RollbackManager` refuses any path outside a run's worktree; the user's index and working tree are byte-identical before and after a run (test).

### WP-2.5 Config and roles load like policy — `todo` [mech] · D-08 · audit §quickstart 4; §scheduler 6
**Files:** `packages/cli/src/config/ConfigLoader.ts` (wired; shape matches `MafConfig`), `.maf/config.yaml` (shape fixed), `packages/roles/src/RoleRegistry.ts` (60–64: fall back to defaults only when the file is missing; parse/validation errors refuse), YAML via the loader from WP-1.5.
**Acceptance:** precedence is CLI flag > `.maf/config.yaml` > defaults, tested per key; a config key the schema doesn't know is an error; a malformed `roles.yaml` refuses to run; the `lcm`, `circuit`, `dag` sections are either read or removed from the shipped file.

### WP-2.6 Planner failure recall — `todo` [core] · D-16 · audit §eval 26
**Files:** `packages/dag-runner/src/DagRunner.ts` or `packages/roles/src/RoleDispatcher.ts` (write Task/Failure nodes on failure), `packages/memory-graph/src/MemoryGraph.ts`, `packages/planning-agent/src/{RetrievalAugmentedPlanner.ts,FailurePatternDetector.ts}` (one query, shared), `packages/memory-graph/src/__tests__/` (real Kùzu).
**Acceptance:** after a failed node, the graph holds a `Task` node and a `Failure` node joined by `MemoryEdge {relation:'CAUSED_FAILURE'}`; the planner's recall query returns it against a real database; `FailurePatternDetector` uses the same query; `querySubgraph` filters before limiting (audit §eval 26, 120-node cap).

### WP-2.7 Offline, isolated evaluation — `todo` [core] · D-14 · audit §eval 1, 6–13
**Files:** `packages/eval-harness/src/*`, `packages/cli/src/commands/{goldens.ts,harness.ts}`, `packages/cli/src/wiring.ts` (adapter registry accepts `scripted`), `.gitignore` (track `.maf/harnesses/default-*.json` and `tests/goldens/baseline.json`), `tests/goldens/corpus.json`.
**Acceptance:** `goldens run --adapter scripted` runs on a fresh clone with no keys and no prior `maf run`, and matches the committed baseline; results record corpus sha, attempts and adapter and `goldens compare` refuses to compare across corpus shas; each evaluation uses a fresh in-memory graph (no injection from past runs); coder tasks fail if `test.js` is modified (`mustNotModify`); the judge prompt and parser agree (JSON `{passed}`); the judge role is distinct from the agent role and the result records which model judged; `maf harness import <file>` validates, copies and indexes; short shas accepted where the store looks up by ref.

### WP-2.8 In-toto attestation — `todo` [core] · D-13 (part 2) · audit §quickstart 14; §security 19, 22
**Files:** `packages/attestation/src/*` (existing in-toto builder used), `packages/harness-config/src/canonicalize.ts` (shared), `packages/cli/src/commands/attest.ts` (new: `maf attest verify <bundle>`), `RoleDispatcher`/`gatedExec` call sites for `recordDiffHash`.
**Acceptance:** the bundle is an in-toto Statement with the run's subjects (diff hashes recorded), signed over canonical JSON; `maf attest verify` succeeds on a bundle and fails on any single-byte change; a bundle re-serialized with different key order still verifies; `keySource` from WP-1.7 is inside the signed payload.

### WP-2.9 Harness identity — `todo` [mech] · audit §quickstart 11–12; §eval 3–4
**Files:** `packages/harness-config/src/store.ts` (`adoptLegacy` 43–49), `packages/roles/src/RoleRegistry.ts` (prompt text hashed into the harness), `packages/cli/src/commands/run.ts` (default `--harness current` when `CURRENT` exists — integration in WP-2.10).
**Acceptance:** editing `roles.yaml` or a `promptFile` changes the harness sha that `run` stamps; `harness set-current` changes what the next plain `run` uses; the attestation's `configSource.digest` equals the harness actually dispatched.

### WP-2.10 Integration: `run.ts` and `wiring.ts` — `todo` [core, maintainer merges]
Wires WP-2.1, 2.2, 2.3, 2.4, 2.5, 2.9 into the two entry points. One PR, after the lanes are merged. **Acceptance:** `run` exercises worktree → in-process coder → security gate → review record → attestation; `inprocess-demo` exercises in-process coder → security gate → an escalated call refused headless → signed attestation with `keySource`, approvals and a subject; the user's tree is untouched.

### WP-2.11 Toolchain floor — `todo` [mech, maintainer merges] · D-21 · audit §quickstart 3, 6, 17
**Files:** root `package.json` (`engines`, `packageManager: pnpm@10.x`, `pnpm.onlyBuiltDependencies`), `pnpm-lock.yaml` (v9, mechanical), `.github/workflows/ci.yml` (pnpm 10), README prerequisites, `packages/cli/src/main.ts` shebang (`#!/usr/bin/env node`; heap flag moved to a documented `NODE_OPTIONS` or a wrapper script).
**Acceptance:** fresh install on Node 22 with pnpm 10 builds native modules without prompts; `npm i -g` of the CLI package puts a working `maf` on PATH on Linux and macOS.

### WP-2.12 CI end-to-end job — `todo` [mech] · D-24
**Files:** `.github/workflows/ci.yml` (job `e2e`: build → `inprocess-demo` → `goldens run --adapter scripted` → compare to baseline, real Kùzu; `timeout-minutes` already present).
**Acceptance:** the job fails if the demo's attestation is missing or the goldens result differs from the baseline; it is in the branch-protection required set.

### WP-2.13 Documentation pass and release 0.3.0 — `todo` [mech, maintainer merges]
Status table rows flipped to *shipped* only for behaviour landed in this phase, each row naming its regression check; POLICY.md, ROLES.md and SECURITY.md updated for approval, review, worktrees, config; CHANGELOG `[0.3.0]`; `docs/DECISIONS.md` statuses. Fresh-clone proof (WP-1.1 script plus `goldens run --adapter scripted`). Maintainer creates the Release.

---

## 7. Phase 3 — release 0.4.0

### WP-3.1 LCM built properly — `todo` [core] · D-17 · audit §eval 27
**Files:** `packages/lcm/src/{LcmEngine.ts,LcmStore.ts,operators/*,GhostCueBuilder.ts,SessionMerger.ts}`, `packages/lcm-adapter/src/*`, `packages/transcript/src/{TranscriptLogger.ts,CompressionAgent.ts}`, `packages/prompt-injector/src/GraphAwareInjector.ts`, first tests for all four packages.
**Acceptance:** summaries are produced by the run's adapter with a configurable model and counted against the node budget; both modes are selectable from config and tested; the fresh tail returns the newest N messages; compaction summarizes exactly the entries it drops (ids match) and a test proves no entry is lost; ghost cues reach the injector and change the prompt; `LlmMap`/`AgenticMap`/`SessionMerger`/`CompressionAgent` are reachable from `run` and tested; one nightly live test exercises a real summarization. Until merged, the README row stays *experimental*.

### WP-3.2 Run persistence and checkpoint — `todo` [core] · D-05, D-18 · audit §eval 28; §scheduler 15
**Files:** `packages/blackboard/src/{BlackboardSqlitePersistence.ts,BlackboardValidator.ts}`, `packages/lcm-adapter/src/FlushOnSnapshot.ts`, `packages/dag-runner/src/DagRunner.ts` (state snapshot/restore; per-run instance state), `packages/cli/src/commands/resume.ts` (new).
**Acceptance:** a run's DAG state, blackboard and worktree branch are persisted under `.maf/runs/<runId>/` at every node boundary; `maf resume <runId>` continues from the last completed node with the same harness sha; a runner instance cannot be reused across runs (state is per run); validator rejects malformed blackboard writes.

### WP-3.3 Provider failover and pause — `todo` [core] · D-05
**Files:** `packages/adapters/base/src/{errors.ts,AdapterChain.ts}` (new), each adapter's error mapping, `packages/roles/src/RoleDispatcher.ts` (chain per role), harness schema (`adapters: [...]`), attestation (`modelUsed`), `run.ts`/`resume.ts` (pause state — integration in WP-3.10).
**Acceptance:** a 429/quota error on the primary moves the call to the next adapter and the attestation records which one ran; an auth error fails the node immediately; with the chain exhausted the run enters `paused`, writes the checkpoint, prints the resume command and the provider's retry-after when known; `maf resume` picks up after the window.

### WP-3.4 Patch-test coder strategy — `todo` [core] · D-18
**Files:** `packages/tool-loop/src/{ToolLoop.ts,PatchTestCycle.ts,CircuitBreaker.ts}` (fix the swallowed-error path at `ToolLoop.ts:104`), `packages/git-ops/src/RollbackManager.ts`, `packages/roles/src/RoleDispatcher.ts` (strategy selection), `run.ts` flag `--strategy patch-test`.
**Acceptance:** with the strategy on, each coder patch is applied, tests run, and a failing result rolls the worktree branch back to the pre-patch commit; after N consecutive failures the breaker trips and the node fails with the history attached; rollback never touches a path outside the run's worktree.

### WP-3.5 DAG from spec — `todo` [mech] · D-18
**Files:** `packages/planning-agent/src/DagSynthesizer.ts`, `run.ts` flag `--plan-from <spec>`, `packages/dag-runner/src/DagParser.ts` (`edges` honoured; duplicate node ids rejected).
**Acceptance:** a spec file yields a deterministic DAG without a model call; the CI e2e job uses it for a two-node run; a spec with a duplicate id or an unknown role is refused at parse time.

### WP-3.6 Evolver as claimed — `todo` [core] · D-15 · audit §eval 14–22; §scheduler 11
**Files:** `packages/evolver/src/{loop.ts,gate.ts,edits.ts,screening.ts,digester.ts}`, `packages/cli/src/commands/evolve.ts`.
**Acceptance:** an edit that cannot affect the target role's effective tier is rejected at proposal with the reason; `gateEvaluate` runs before any goldens spend (test: a screened-out prompt never reaches the runner); `runSmoke` runs the target task; sensitive candidates are stored and `maf evolve approve <id>` ships one; `applyEdit` on an unknown role and graph errors in `digestEvidence` are caught and logged, never fatal; the `system-prompt-leak` regex matches phrases, not the words "print"/"repeat"/"reveal"; `add_processor` on an empty bundle starts from the default bundle and a harness lacking `security-gate` or `secret-redact` for a writer role is rejected; `PolicyEvent` nodes are written by the policy engine and `EvolutionRound` nodes are read by the digester; candidate ids do not grow unboundedly; a wall-clock and token budget bound the loop.

### WP-3.7 Kùzu 0.11.3 — `todo` [core] · D-20 · audit §eval 23–25
**Files:** `packages/memory-graph/package.json` (`kuzu: 0.11.3` exact), `packages/memory-graph/src/{KuzuDriver.ts,MemoryGraph.ts}` (schema errors surfaced; close path re-tested), `packages/cli/src/commands/graph.ts` (new: `export`, `import`), `pnpm-lock.yaml`.
**Pre-condition:** on the maintainer's machine, `pnpm add kuzu@0.11.3` in a scratch project installs a prebuilt binary (no compile) for the platform — reported before the PR is opened. If it compiles from source, stop.
**Acceptance:** `maf graph export` writes nodes and edges as JSON; `import` restores them into a fresh database and a query returns the same rows; opening a 0.7-format database prints the export/upgrade instructions and exits non-zero; the four real-Kùzu tests pass on 0.11.3; `db.close()` is called and does not crash (or the reason it still can't be is documented with a test that pins it).

### WP-3.8 Hardening — `todo` [core] · D-10, D-11 · audit §security 2, 8, 9, 10, 24, 32, 37, 39, 41
**Files:** `packages/adapters/base/src/ProcessSpawner.ts` (env filter), `packages/tools/src/plugins/{patch.ts,test-runner.ts,grep.ts}`, config loaders (`JSON.parse` reviver rejecting `__proto__`/`constructor` keys), `packages/evolver/src/gate.ts`, `docs/SECURITY.md`.
**Acceptance:** tools spawn with the allowlisted env and a test proves `MAF_SIGNING_KEY` is absent in a child; backend CLIs receive the env minus `MAF_*`; `patch.apply` declares the files the chosen `strip` actually touches plus `.orig`/`.rej`, and the temp diff is created `0600`; `test.run` enforces the runner allowlist, `--` before arguments, a timeout ceiling, and kills the process group; a config file with a `__proto__` key is rejected; the evolver gate refuses to widen a role's tool allowlist with a write tool unless the edit is marked sensitive; SECURITY.md states each of these as implemented.

### WP-3.9 Consolidation — `todo` [mech] · D-18
**Files:** `packages/memory-graph/src/{SubgraphQuery.ts,RunMerger.ts,MemoryGraph.ts}`.
**Acceptance:** one implementation of subgraph query and run merge, used by every caller; `mergeRuns` preserves edges; tests moved, not deleted.

### WP-3.10 Integration: pause/resume, failover, strategies into `run.ts` — `todo` [core, maintainer merges]
Wires WP-3.2, 3.3, 3.4, 3.5 into the entry points. **Acceptance:** a scripted run that is interrupted after node 1 resumes and completes; a scripted provider failure fails over and the attestation shows both models.

### WP-3.11 Tests, CI and nightly — `todo` [mech] · D-24, D-25
**Files:** `packages/cli/src/__tests__/` (every command, `wiring.ts`), `packages/adapters/*/src/__tests__/` (fake `claude`/`gemini`/`codex` binaries on `PATH`; verify the real `claude` flag set once on the maintainer's machine and pin it in a test fixture), `.github/workflows/nightly.yml` (live goldens with the Anthropic key, `$50` cap via run limits; evolve weekly, `$150`), `scripts/check-test-scripts.mjs` (every package with `src/` must have tests).
**Acceptance:** no package the CLI depends on is untested; the nightly job runs the live goldens and posts the result as a workflow summary; CI total time under 10 minutes.

### WP-3.12 Documentation pass, exit audit, release 0.4.0 — `todo` [maintainer merges]
Status table: every row *shipped* names its check; LCM, evolver, failover, patch-test, DAG-from-spec, Kùzu rows flipped; CHANGELOG `[0.4.0]`; `DECISIONS.md` statuses. Then the exit audit: a verifier with no prior context runs the three criteria of §1 and reports. Release only on a clean report.

---

## 8. Phase 4 — release 0.5.0 (scoped later)

Port from `maf-v1` into the public trunk (owner decision 7): `@maf/mcp-tools` with the known fixes — injected parameters override model input (`{...input, ...injected}`), filtered env for stdio servers, the Cognitive Fabric preset's `analyze`/`detect` rated destructive per CF 0.1.0's published annotations — then `resolveHarnessForRun`, encryption at rest (E1, AgentVenture key design: OS-keychain master key behind a provider interface, HKDF subkeys, per-record AES-256-GCM, fail closed), and the prompt-injector test script. The architect writes the WPs from the v1 checklist after 0.4.0 ships.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Kùzu 0.11.3 prebuilt missing for a needed platform | WP-3.7 pre-condition; stop before any source build; alternatives discussed with the maintainer |
| In-process default breaks non-Claude users | `--allow-ungoverned` with a clear message; README Status row says which adapters are governed |
| Worktrees on repositories with submodules or LFS | WP-2.4 tests include a submodule fixture; document unsupported cases |
| Live validation flakiness masks regressions | nightly results compared as trends; a single flaky night does not fail `main` |
| Review bandwidth | PR size cap; lanes sized to 3–5 PRs/day; integration serialized |
| Agents "fixing" beyond scope | stop-and-ask list (§3.3); verifier checks the diff against the WP's file list |
| Budget overrun | per-PR caps with stop-at-cap; workspace spend limits as the hard stop |

---

## 10. Reporting template (per WP)

```
WP-x.y <title> — <status>
PR: #<n>  merge: <sha>  CI: <run id>  verifier: pass|fail (<one line>)
Acceptance test(s): <file::case>
Deliberately not done: <items, with the WP they move to>
Budget: $<spent> of $<cap>
```
