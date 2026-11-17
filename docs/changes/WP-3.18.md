# WP-3.18 — run viewer (D-63)

Branch: `wp/3.18-viewer` → `wp/phase-3b` (off `6150914`)

`maf view <runId | bundle path> [--out <file.html>]` and `maf view --session <id>` write one
self-contained, network-free HTML file from the signed record alone.

## §8.1 readiness check — observables the tests must touch that the spec does not name

Written before any test or implementation. Each entry is a spec gap (§8.1), not a design note.

### A. The module surface (the spec names the command and the HTML, no API)

1. **Package and entry** — the spec owns `packages/viewer/**` but does not name the package or its
   entry point. Assumed `@maf/viewer`, `src/index.ts`, matching every other workspace package.
2. **Renderer entry points** — the acceptance list is written against rendered HTML, so the tests
   need callable names. The tests are authored against `renderRunView`, `renderSessionView`,
   `viewRun`, `viewSession` and `escapeHtml`; the spec names none of them.
3. **Effect set** — acceptance 4 requires a spy on `fs`, so the file reads and the write must be
   parameters. The tests inject `{ readFile, writeFile }`; the spec does not name this seam.
4. **Default output path** — `--out` has no default in the spec. Chosen: `.maf/views/<id>.html`
   (the default stays inside `.maf/`; `--out` may name any file).
5. **`--dir`** — every existing command takes one; the spec's command line does not show it.
6. **Input resolution** — `<runId>` is not defined. Chosen: `.maf/attestations/<runId>.bundle.json`
   with `.maf/transcripts/<runId>.jsonl` read when present; a path is read as the bundle and no
   transcript is read. `--session <id>` reads `.maf/evolve/<id>.json`. Not in the spec.
7. **Signing source** — the spec names the banner's key source, not how the check is made. The
   command reads `MAF_SIGNING_KEY` the way `maf attest verify` does (`Attestor.report` under
   `{secret}`; unset/empty/dev means the public development key, with a one-line stderr note —
   not the run's signing warning); a test passes the signing options it wants.
8. **Join key** — nothing in the record links a model surface or tool call to a node except
   `taskId`, which `RoleDispatcher` sets to the node id (`makeTaskId(node.id)`). Not in the spec;
   if it changes, every per-node section silently empties, so a test pins it.
9. **Token source** — "reported vs estimated" names no source. Reported: `lcmSummary.reportedTokens`
   (only LCM calls report usage). Estimated: the transcript entry's `tokens`, which is
   `ceil(content.length / 4)` (`estimateTokens`). Not in the spec.
10. **HTML contract** — the spec names what must appear, not element ids, headings, banner wording,
    number/time rendering, or the order of equal-timestamp nodes. The tests pin all of it: UTC ISO
    strings exactly as recorded, integer milliseconds, no locale formatting, nodes ordered by
    `(startedAt, nodeId)` with absent times last.
11. **Scale budget** — acceptance 5 defers "a stated size" to the implementer. Stated: **8 MiB**
    and **under 10 s** for 500 nodes / 10,000 surfaces.

### B. Blocking gaps — the record does not hold what the spec asks the viewer to show

Rendered as `not recorded` under acceptance 6 and §4; never as empty or zero.

12. **DAG edges, labels, `maxConcurrent`** — `Dag.edges` is never persisted. `RunOutcome.nodes` is
    `DagNodeExecution[]` (no edges, no label), and the shipped 0.3.1 fixture has no `nodes` at all.
    The viewer renders a time-ordered node table and computes overlap from the recorded
    `startedAt`/`finishedAt` intervals; it states that edges and `maxConcurrent` are not recorded.
13. **Dollars** — no price table exists in the repository or the record, and `ToolCallRecord` has
    no usage field. Dollars render as `not recorded`; tokens render reported/estimated only where
    an LCM summary reports them or a transcript exists.
14. **LCM "expansions"** — no such record exists. The bundle carries `lcmSettings`, `lcmDegraded`
    and per-call `lcmSummary` (messages, chars, tokens), and those are rendered; expansions are
    `not recorded`.
15. **Evolver held-out result, test statistic, p-value, contaminated attempts** — none exists in
    `EvolveReport`/`EvolveRoundRecord`/`SensitiveEvaluation`/`GoldenSuiteResult` (the second half
    of D-57 is unimplemented). Train scores do exist (`currentScores`/`candidateScores`) and are
    rendered per task. A gate `stage` exists only on a `reject` verdict.
16. **"Every bundle version since 0.3.1"** — the bundle carries no schema-version field. Two
    on-disk shapes exist and both parse: the legacy 0.2.x layout and the in-toto 0.3.x statement.
    The fixtures cover both; "version" is otherwise unobservable.
17. **Unsigned bundle** — `parseBundle` *throws* for a file with no string `signature`, so the
    spec's "unsigned bundle renders a red banner" requires the viewer to catch the parse error and
    render the banner rather than fail. The spec assumes an unsigned file is readable.
18. **`no_change`** — the spec lists it as a node verdict beside `Succeeded`/`Failed`/`Unclaimed`.
    It is a failure *kind* (`failure.kind`), not a `DagNodeStatus`; the viewer renders status and
    failure kind as separate fields.
19. **`deferredWriters`** — a hold-back list the spec does not name; rendered with the unscheduled
    nodes, labelled separately.
20. **D-63 does not exist** — `docs/DECISIONS.md` stops at D-59. The spec cites a decision the
    repository does not carry. A decision is a §5 authority; the maintainer must add it, and this
    lane cannot. Reported as a spec defect.

## CONFLICT — the workspace link the ownership list omits, measured (exception granted)

The spec puts the command in `packages/cli/src/commands/view.ts` and the renderer in the new
`packages/viewer`, but the declared owned files are only `packages/viewer/**` and `view.ts` (plus
the `main.ts` registration line), under "no dependency or reserved-file changes". A CLI that
imports a new workspace package cannot be built without:

- `packages/cli/package.json` — one `"@maf/viewer": "workspace:*"` entry;
- `packages/cli/tsconfig.json` — one `{ "path": "../viewer" }` reference, beside the other 25
  (the CLI lists a project reference for every package it depends on);
- `packages/viewer/package.json` — `typescript: "*"` and `@types/node: "*"`, the pair every sibling
  package declares; both resolve to versions already in the lockfile (5.9.3 and 20.19.43);
- `pnpm-lock.yaml` — the importer entries that mirror them (reserved, §1).

Measured before the exception, with the pre-exception manifests (pnpm 10.34.7, offline, scratch copy):

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" …
* 2 dependencies were added: @maf/attestation@workspace:*, @maf/types@workspace:*
```

The lockfile delta after `pnpm install --offline` (added lines, unchanged context trimmed):

```
+      '@maf/viewer':            (packages/cli importer)
+        specifier: workspace:*
+        version: link:../viewer
+
+  packages/viewer:             (new importer block)
+    dependencies:
+      '@maf/attestation':
+        specifier: workspace:*
+        version: link:../attestation
+      '@maf/types':
+        specifier: workspace:*
+        version: link:../types
+    devDependencies:
+      '@types/node':
+        specifier: '*'
+        version: 20.19.43
+      typescript:
+        specifier: '*'
+        version: 5.9.3
```

19 added lines: three workspace links, the new importer, and the sibling devDependency pair at
**versions already in the lockfile — no new external specifier, no resolved version moved, no
registry change**. The standing rule covers the workspace links, but a lockfile edit needs a
written one-PR exception, so the lane asked for one.

### The maintainer's exception (granted 2026-11-16, with PR #66)

> One-PR exception for PR #66 (WP-3.18): the coder may change pnpm-lock.yaml, packages/cli/package.json and packages/cli/tsconfig.json, and create packages/viewer/package.json (including its version field), only to add the workspace package @maf/viewer and its links (@maf/cli → @maf/viewer; @maf/viewer → @maf/attestation, @maf/types; and the sibling-standard devDependencies typescript and @types/node at the versions the other packages already use). No other dependency, version or registry change.

The four files above are exactly the files it names, and the diff adds nothing outside them; the
revert is the same lines.

## Design

- **`packages/viewer/src/model.ts`** — pure: bundle JSON + optional transcript + verification
  report → `RunView`; evolve report JSON → `SessionView`. Absence is `null` throughout ("not
  recorded" is the renderer's word for it; an empty array is "none (recorded)"). No I/O, no clock.
- **`packages/viewer/src/render.ts`** — pure: view model → HTML string. One `escapeHtml`; a fixed
  CSS string; no external asset, no URL. Verifies first (`parseBundle` → `Attestor.report`) and
  renders only the banner when the record does not verify.
- **`packages/viewer/src/viewer.ts`** — the shell: paths in, HTML out, `{ readFile, writeFile }`
  injected (`ViewerIo`). Default I/O is `node:fs/promises`; `writeFile` creates the output
  directory. A missing transcript is ENOENT-absent, not an error.
- **`packages/cli/src/commands/view.ts`** — Commander wiring only: resolve `--dir`, read
  `MAF_SIGNING_KEY` the way `maf attest verify` does (with its own stderr note; the run's
  signing warning would be wrong here), and call the viewer.
- Redaction: every free-text value goes through `redactEvidenceText` (which includes
  `redactText`), the stricter of the two tiers. Absolute paths therefore render `[REDACTED:path]`.
- Verification runs first and decides the banner: `invalid` → red, `dev` key → amber (a valid
  dev-key record is no evidence of authorship), `env` key → green.

## Tests (blind, authored before the implementation)

`packages/viewer/src/__tests__/viewer.test.ts` plus `fixtures/` and one hand-authored
`golden/single-node.html`. Every expectation carries an `ORACLE:` line naming the spec clause or
record field it comes from. The signing oracle in the test is an independent JCS+HMAC
implementation over the fixture bytes, not the viewer's verifier.

Two changes after the first run, both mechanical and disclosed (§8: neither touches an assertion):

1. **Fixture path.** The test located `fixtures/` and `golden/` beside `__dirname`, which at run
   time is `dist/__tests__`. Now two levels up to `src/__tests__`, the repo's own convention
   (`packages/attestation/src/__tests__/intoto.test.ts` does the same).
2. **One fixture string.** `parallel-dag.bundle.json` carried a sample tool input naming a
   Markdown file under `docs/`; `check:doc-refs` treats such names in `.json` prose as citations
   and failed. The sample is now `docs/spec.txt`, and the fixture was re-signed by the authoring
   script (identical bytes elsewhere — verified by diff).

## Verification

**macOS 15.5 (x86_64), Node v25.6.0, pnpm 10.34.7 — measured at this tree:**

- `pnpm install --frozen-lockfile --offline` passes with the 19-line delta above (it fails without
  it, as quoted). `pnpm -r build`: 28/28. `pnpm -r typecheck`: all 28 Done.
- `@maf/viewer` suite: **24 tests, 24 passed, 0 failed**. Acceptance 5's own figure, re-measured
  outside the suite: 500 nodes / 10,000 surfaces → **520 ms, 4.71 MiB** (budgets 10 s / 8 MiB).
- `@maf/cli` suite: **289 tests, 288 passed, 1 skipped, 0 failed**.
- Whole repo (`pnpm -r test`): **26 package suites, 1729 tests, 1727 passed, 2 skipped, 0 failed,
  exit 0.**
- Guards, all `OK`: `check:test-scripts` (26/28 declare a test script; `@maf/blackboard` and
  `@maf/lcm-adapter` have none), `check:build-output` (28/28), `check:workspace-deps` (28
  packages, 97 internal edges, acyclic), `check:doc-refs` (92 `.md` references plus 5 declared
  runtime artifacts), `check:package` (36 files, installed and run; demo `goldens solved 4/10`).
- End-to-end `maf view`: by run id on the shipped 0.3.1 fixture (amber dev banner, written to
  `.maf/views/<id>.html`), by bundle path with `--out`, and `--session <id>` (renders `stop
  reason: budget`). The 0.3.1 view shows `[REDACTED:path]` where the record carries an absolute
  policy path, and contains no `https?://`.

**A pre-existing artifact class, disclosed (§10):** ten compiled test files in `dist/__tests__`
from a previous branch (one `goldens-calibrate` in `@maf/cli`, nine in `@maf/eval-harness`) had no
source on this branch — `tsc` never prunes. They produced 9 false-red cli tests (`tests/goldens/splits.json` ENOENT). They were removed before the numbers above; a clean checkout (CI) never has
them.

**Linux (the arbiter): 26 package suites, 1729 tests, 1727 passed, 2 skipped, 0 failed,
`LINUX_RC=0`.** A `node:22` container over a `git archive` of the commit that carries this
fragment: `npm i -g pnpm@10.34.7`, `pnpm install --frozen-lockfile`, `pnpm -r build`, then
`pnpm -r --no-bail --workspace-concurrency=1 test`. The viewer's own block there is `1..24`,
24 pass, 0 fail — the same totals as macOS, from a clean tree (the container never sees a stale
`dist/`).

## Not in this lane

- D-63 in `docs/DECISIONS.md` (maintainer's authority).
- Any DAG edge/label/`maxConcurrent` record; pricing; LCM expansions; held-out/p-value/contamination
  records (all absent from the signed record — see B).
- Packaging/release wiring.
