# WP-3.6 — the DAG from a spec, with no model call

Branch: `wp/3.6-dag-from-spec` → `wp/phase-3b`

## What this changes

A JSON workflow spec is now a plan `maf run` can execute: `--plan-from <spec>` reads the DAG from the
file, never asks the planner, and refuses a spec that names one node twice or an edge to a node it does
not define. A spec's `edges` were previously kept beside the DAG and never read — the scheduler reads
`node.dependencies` — so `a -> b` ran `a` and `b` concurrently: a plan read from a file said one thing
and the run did another. Both builders now apply the same rule.

### Reading a plan instead of asking for one

- **`packages/cli/src/commands/run.ts`** — `--plan-from <path>` (`RunOptions.planFrom`). The plan
  branch prints `[maf] plan: <path> (read from spec, no model call)`, resolves the path against the
  working directory, and calls `new DagSynthesizer(roles).fromFile(...)`. The planner is not
  constructed on that path, so there is no call to make and nothing to fall back to. DAG settings
  (`config.dag`) still apply.
- **`packages/planning-agent/src/DagSynthesizer.ts`** — `fromFile` reads the file as JSON and refuses,
  by name, a file that is not JSON or has no `nodes` array. `synthesize` refuses a duplicate node id
  while the spec is still a list (a `Map` would silently keep the last), and turns each edge into the
  target's dependency. Ids are derived from content, not the clock: `spec.id` when given, otherwise
  `sha256(JSON.stringify(spec))`; an edge id is `e<i>:from->to:kind`. The same file therefore parses
  to the same DAG every time.
- **`packages/dag-runner/src/DagParser.ts`** — the same edge rule, exported as
  `applyEdgeDependencies`, plus `contentId` for a spec that names no id. The synthesizer cannot import
  this package (`@maf/planning-agent` does not depend on `@maf/dag-runner`), so the rule is carried in
  both places and both are tested; neither adds a dependency.

### Refusals that happen at parse time

- A duplicate node id: `DagSynthesizer: duplicate node id "n1"` / `DagParser: duplicate node id "n1"`.
- An edge naming a node the spec does not define, in either direction:
  `edge names unknown node "ghost" (from|to)`.
- An unknown `agentRole` is refused by the existing role rule, at the builder, not at dispatch.
- A file that cannot be read as JSON, or has no `nodes` array, is refused with the path in the message.

Specs are JSON only. `@maf/planning-agent` has no YAML parser and the planner's own output is JSON, so
reading YAML would mean a new dependency for a format this path does not produce.

## Proof

- `packages/dag-runner/src/__tests__/plan-spec.test.ts` — an edge makes its target depend on its
  source; an edge and a listed dependency agree rather than duplicate; either unknown endpoint is
  refused; the same spec yields the same DAG id and edge ids; an unnamed spec gets a sha256 content id.
- `packages/planning-agent/src/__tests__/DagSynthesizer.test.ts` — duplicate id refused; edge becomes
  a dependency; unknown endpoint refused; a spec file yields the same DAG on every read; a file that is
  not a workflow spec is refused by name.
- `packages/cli/src/__tests__/plan-from.test.ts` — `maf run --plan-from` with a two-node spec (`n1 ->
  n2`) and a scripted model: both nodes run, `n2` starts only after `n1` succeeded, the plan line says
  the file was read, no planner call is made (every `invoke` is the security gate's review), and both
  nodes' files are on the run branch.
- CI, e2e job: the two-node run above, and a second step that runs the built CLI on a spec naming
  `n1` twice and fails unless the run stops with `duplicate node id "n1"`.
