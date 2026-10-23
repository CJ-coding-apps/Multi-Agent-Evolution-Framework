# WP-3.6 — the DAG from a spec, with no model call

Branch: `wp/3.6-dag-from-spec` → `wp/phase-3b`

## What this changes

A JSON workflow spec is now a plan `maf run` can execute: `--plan-from <spec>` reads the DAG from the
file, never asks the planner, and refuses a spec it cannot read in full — one that names a node twice,
names an edge endpoint the spec does not define, contains a cycle, or carries a key the format does not
define. The spec is read, schema-checked and synthesized **before anything is written**: before `.maf/`
is created, before the harness the run dispatches is minted or imported, before `checkForRun` creates a
`maf/<runId>` branch, before the worktree, and before the run's own stores open. So every refusal
leaves the repository and `.maf/` byte for byte as it found them (R1: harness resolution is read-only
and its one write is deferred behind `persist()` until the spec is accepted).

A spec's `edges` were previously kept beside the DAG and never read — the scheduler reads
`node.dependencies` — so `a -> b` ran `a` and `b` concurrently: a plan read from a file said one thing
and the run did another. Both builders now apply the same rule.

The test that pins the ordering lists `n2` **first** and `n1` second, with the edge `n1 -> n2` (F2).
Both nodes are writers, so the writer lock serializes them too — in the order the spec lists them.
Listed order alone would therefore have started `n2`; only the edge can make it wait, so the test fails
if the edge rule is removed (verified by mutation: dropping the rule makes the test fail at *"n2 starts
only after n1 ended: the edge is an ordering constraint"*).

### The spec format, named once

`--plan-from` reads the **narrow** format `DagSynthesizer` defines, and only that:

```json
{
  "id": "two-node",
  "nodes": [
    { "id": "n1", "label": "Fix sum.js so the test passes" },
    { "id": "n2", "label": "Add the helper module for the fix", "agentRole": "coder" }
  ],
  "edges": [{ "from": "n1", "to": "n2" }]
}
```

| Level | Keys it accepts | Everything else |
|---|---|---|
| spec | `id`, `nodes`, `edges` | refused by name |
| node | `id`, `label`, `agentRole`, `dependencies`, `timeoutMs`, `metadata` | refused by name, including `config`, `retry`, `inputs`, `outputs` |
| edge | `from`, `to`, `kind` (`data`, `control`, `review`) | refused by name |

The other spec reader in this repository is `DagParser.fromSpec`, reached through `fromMarkdown` — the
WORKFLOW.md front-matter form. It accepts a **wider** spec: a top-level `config` and per-node `retry`,
`inputs` and `outputs`. It is not what `--plan-from` reads. The two exist for two callers: WORKFLOW.md
carries a run configuration with a plan in it, while `--plan-from` is a plan the operator wrote for one
run. Saying which one is *the* spec format matters because a key one accepts the other refuses — a
single unqualified sentence about "the spec format" would be false for one of them.

### Reading a plan instead of asking for one

- **`packages/cli/src/commands/run.ts`** — `--plan-from <path>` (`RunOptions.planFrom`, line 105
  option / 52 type). The spec is synthesized at 201–209, before `checkForRun` at 269; the plan branch
  prints `[maf] plan: <path> (read from spec, no model call)` at 386. The planner is **not
  constructed** on that path — its factory lives only in the `else` branch at 388–401 — so there is no
  call to make and nothing to fall back to. DAG settings (`--config`'s `dag`) still apply, through the
  same `applyDagSettings` the planned path uses.
- **`packages/planning-agent/src/DagSynthesizer.ts`** — `fromFile` stats the file first (size is
  checked before the bytes are read, and again on the bytes actually loaded), reads it **as a
  Buffer**, digests those bytes, and only then decodes them strictly as UTF-8 — so the digest the run
  records names the file the operator wrote, not a lossy re-encoding of it (R4). It refuses, by
  name, a file that is not UTF-8, is not JSON, or has no `nodes` array. `synthesize` validates the whole spec first (closed schema, caps, duplicate
  ids, unknown dependencies, self-edges, cycles) and turns each edge into the target's dependency. Ids
  are derived from content, not the clock: `spec.id` when given, otherwise `sha256(JSON.stringify(spec))`;
  an edge id is `e<i>:from->to:kind`. The same file therefore yields the same DAG on every read.
- **`packages/dag-runner/src/DagParser.ts`** — the same edge rule, exported as
  `applyEdgeDependencies`, plus `contentId` for a spec that names no id. The synthesizer cannot import
  this package (`@maf/planning-agent` does not depend on `@maf/dag-runner`), so the rule is carried in
  both places and both are tested; neither adds a dependency.

### Refusals that happen at parse time

Every one of these is raised before anything is created (F1):

- a body that is not a JSON object, or has no `nodes` array: *must contain a JSON object with a
  "nodes" array*;
- no nodes: *the spec has no nodes; a plan needs at least one*;
- more than 200 nodes / 2000 edges: the count and the cap are named;
- a `timeoutMs` below 1 or above 2147483647: the ceiling every millisecond field uses, shared as
  `MAX_TIMER_MS` in `@maf/types` with `.maf/config.yaml`'s loader. Above it a Node timer fires after
  1 ms, so a larger timeout means "at once" — the opposite of what the spec asks for;
- a file over 1 MiB: *it is N bytes; a spec may be at most 1048576* — read from `stat`, so the file is
  not loaded to find out, and checked again on the bytes that were loaded;
- a file that is not UTF-8: *<path> is not valid UTF-8; a JSON workflow spec must be UTF-8 text* —
  the bytes are hashed before they are decoded, and the decode is strict, so a lossy read cannot
  digest a re-encoding and cannot turn bad bytes into a confusing JSON parse error;
- a duplicate node id: `duplicate node id "n1"` (a `Map` would silently keep the last);
- an edge naming a node the spec does not define, in either direction:
  `edge names unknown node "ghost" (from|to)`;
- a self-edge or a self-dependency, and a dependency cycle — Kahn's algorithm, naming every node still
  waiting;
- an unknown `kind`: the accepted kinds are listed;
- an unknown `agentRole`: the existing role rule refuses it at the builder, naming the roles that exist;
- an unknown key at any level: the offending keys are quoted and the accepted set listed (F6). The typo
  `agnetRole` is the case that motivated it — it used to be dropped, silently giving the node the
  default writer role.

### What the run records about its plan (F4)

`planSource` says where the plan came from — `{ kind: 'spec', path, sha256 }` (the digest of the bytes
that were read) or `{ kind: 'planner' }` — and is recorded in three places: the attestation bundle's
invocation parameters (`run.ts:435`), one transcript line (`plan source: spec <path> (sha256 <hex>)` /
`plan source: the planner`, `run.ts:317`, built at 508), and the Run node's properties
(`run.ts:376`). Without it, a run planned by a model and a run read from a file differ only in a line
of stdout that is not part of the signed record.

## Decisions

**D-56 · A plan read from a file is the operator's plan: it is JSON, its edges order execution, recall
does not alter it, and a key the format does not define is refused rather than ignored.** Four rulings
on what `--plan-from` may do to a spec:

1. **JSON only.** `@maf/planning-agent` has no YAML parser, and adding one would be a new dependency
   for a format the planner's own output never uses. A YAML file is refused as a JSON parse error that
   names the path — not half-read.
2. **An edge is an ordering constraint.** `a -> b` means `b` starts only after `a` succeeded. The
   scheduler reads `node.dependencies`, not `edges`, so stored edges used to be decoration: a spec whose
   only ordering was an edge ran both nodes at once. `DagParser.fromSpec` and
   `DagSynthesizer.synthesize` now apply the same rule, each in its own package.
3. **Recall is skipped.** The planner reads past failures from the memory graph and may insert review
   gates. Under `--plan-from` no patterns are passed, so `reviewGateNodeIds` is empty: memory must not
   rewrite a plan a human wrote. The run's title still rides on every node (D-16), so a failure this
   plan causes is filed under the title a later recall searches for.
4. **Unknown keys are refused, by name.** The spec accepts `id`, `nodes`, `edges`; a node `id`,
   `label`, `agentRole`, `dependencies`, `timeoutMs`, `metadata`; an edge `from`, `to`, `kind`. Anything
   else is rejected with the keys quoted and the accepted set listed — `config` at the spec level,
   `retry`/`inputs`/`outputs` at the node level (run-config keys copied from `DagParser`'s wider form),
   and misspellings such as `agnetRole`, which previously vanished and left the default writer role in
   place.

Two bounds and one resolution rule go with these (F11): a spec may be 1 MiB, 200 nodes and 2000 edges —
bounds on what one operator file can make the scheduler do — and the path is resolved against `--dir`,
as `--roles` and `--policy` are, so a spec is found where the run's other files are.

**Rejected — accept `DagParser`'s wider spec, so one format serves both readers.** That form carries
`config`, per-node `retry`, `inputs` and `outputs`. Honouring them under `--plan-from` would make the
file a run configuration, silently competing with the run's own `--config`; accepting and ignoring them
is the silent-drop defect this WP exists to remove. Refusing them by name keeps the file a plan, and
makes the difference between the two formats visible in the error rather than in a document.

## Docs

**A plan can be a file.** `--plan-from <spec>` reads a JSON workflow spec —
`{"nodes": [...], "edges": [...]}` — and runs that DAG instead of asking the planner. There is no model
call, the same file always yields the same DAG (ids come from its content, not the clock), and the spec
is refused before anything runs when it names one node twice, names an edge endpoint the spec does not
define, contains a cycle, or carries a key the format does not define. `edges` are ordering constraints:
`a -> b` means `b` starts only after `a` succeeded. A spec may be at most 1 MiB, 200 nodes and 2000
edges. A relative path is resolved against `--dir`, as `--roles` and `--policy` are — not against the
directory you happen to run `maf` from; specs are JSON only.

This paragraph was the README text `ece3ba2` added. `ce2a401` moved it here — docs go by fragment — so
the branch's net diff leaves `README.md` unchanged.

## Files outside the spec's list, and why

The spec (`docs/BUILD_PLAN.md`, WP-3.6) lists `DagSynthesizer.ts`, the `run.ts` `--plan-from` flag and
`DagParser.ts`. This branch also changes:

| File | Why |
|---|---|
| `packages/cli/src/commands/run.ts` | The spec's "run.ts flag", plus what the flag needs: the `DagSynthesizer` import, the spec branch (deliberately before `.maf/` exists and before `checkForRun`), the plan line, `planSource` on the Run node / transcript / bundle, and the planner factory confined to the `else` branch so it cannot be constructed on this path. |
| `packages/types/src/index.ts` | Additive: the `PlanSource` union the bundle, transcript and Run node share. Nothing existing changed shape. |
| `.github/workflows/ci.yml` | **Withheld pending the maintainer's ruling (F8).** `ece3ba2` added two e2e steps (a two-node `--plan-from` run and a duplicate-id refusal). This branch removes them, returning the file byte-for-byte to `wp/phase-3b`'s version, because F8's ruling has not been granted. The two steps belong in `ci.yml` when it is. |
| `packages/cli/src/__tests__/plan-from.test.ts` | The end-to-end tests (see Proof). |
| `packages/planning-agent/src/__tests__/DagSynthesizer.test.ts` | The unit tests for the schema, caps, roles and metadata. |
| `packages/dag-runner/src/__tests__/plan-spec.test.ts` | The edge rule and content ids, on the parser side. |

## Proof

- `packages/cli/src/__tests__/plan-from.test.ts`, five tests:
  - **the two-node run (F2, F3, F4):** the spec lists `n2` first and `n1` second, with edge `n1 -> n2`;
    a scripted model does the work. Asserts `n1` ends before `n2` starts (only the edge can cause
    that), the plan line, `running DAG with 2 node(s)`, that the planner factory was called **zero**
    times (it throws if it is), no `invoke`/`task` exchange (the planner was never asked), both files on
    `maf/<runId>`, and `planSource = {kind:'spec', path, sha256}` in the bundle, the transcript entry
    and the Run node.
  - **the refusal sweeps (F1, R1, R3, R4):** every refusal case — unknown node key, unknown spec key,
    duplicate id, unknown edge endpoint, cycle, the two `timeoutMs` bounds, a file that is not UTF-8,
    no nodes, missing file — each asserting the message. They run
    twice. In a repository maf has **never run in** (no `.maf/`), every path and its bytes — `.git/`
    included — and `git status` are identical afterwards, and `.maf/` still does not exist. In a
    repository `maf init` has run in, `.maf/` is unchanged. Neither test pre-saves a harness or seeds
    a `.gitignore`: those were what hid the defect, because the resolution used to adopt a harness
    before the spec was read.
  - **the failure is recallable (F7):** a strict harness makes the node fail; the Task record's label
    is the node's own description and its `runTitle` is the run title, and `recallFailures` for that
    title finds the run.
  - **the planner path still records itself (F4):** a planner-planned run records
    `planSource = {kind:'planner'}` in the same three places, with the factory called once — the seam
    is wired to the real `RetrievalAugmentedPlanner`, so the spec test's zero is not vacuous.
- `packages/planning-agent/src/__tests__/DagSynthesizer.test.ts` — the closed schema (every container
  shape refused with a sentence, never a raw `TypeError`), ids/labels/timeouts, unknown `kind`, unknown
  keys at spec/node/edge level including `retry`/`inputs`/`outputs`, duplicate ids, unknown
  dependencies, self-edges and cycles, the byte/node caps, content ids (F10), roles, the edge rule, and
  the metadata rule: every node carries the run title, keeps its own label as `taskDescription` unless
  the operator named one, and recall inserts a review gate only when patterns are passed.
- `packages/dag-runner/src/__tests__/plan-spec.test.ts` — an edge makes its target depend on its
  source; an edge and a listed dependency agree rather than duplicate; either unknown endpoint is
  refused; the same spec yields the same DAG id and edge ids; an unnamed spec gets a sha256 content id.
