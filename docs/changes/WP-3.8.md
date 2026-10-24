# WP-3.8 — Kùzu 0.11.3 and the graph export/import (D-58)

Branch `wp/3.8-kuzu-0.11.3` → `wp/phase-3b`. The `kuzu` entry in
`packages/memory-graph/package.json` and the `kuzu` entries in `pnpm-lock.yaml` changed under the
maintainer's one-PR exception for this branch; nothing else in either file changed.

## What changed

**The dependency.** `packages/memory-graph` declares `kuzu: "0.11.3"` (exact), replacing
`^0.7.0` (which resolved to 0.7.1). The lockfile diff is the importer specifier/version, the
`kuzu@0.7.1` → `kuzu@0.11.3` package entry (with its new integrity hash) and the corresponding
snapshot key; both versions depend on `cmake-js ^7.3.0` and `node-addon-api ^6.0.0`, so no
transitive resolution moved. The npm registry prints `Package no longer supported` for 0.11.3 and
still installs the prebuilt binary; that deprecation is expected — Kùzu 0.11.3 is the final release
(D-51, WP-3.0p).

**The driver.** `KuzuDriver` reaches the connection only through the public `conn.init()`, which
both 0.7.1 and 0.11.3 expose; the undocumented `_getConnection()` cast is gone. A database that is a
**directory** (the 0.7.x shape) fails at `conn.init()` with `Database path cannot be a directory`,
and that failure is turned into a `GraphOpenError` naming the export/import route (below). Every
other opening error keeps its own message — inventing a migration story for a genuinely corrupt
file would send the user down the wrong path.

**One behaviour the bump changed, restored.** 0.7.1 created a missing parent directory when a
database path was named; 0.11.3 refuses (`Cannot open database because the directory does not
exist`). `buildRunStack` passes `<mafDir>/memory.kuzu` for a `mafDir` the caller may not have made,
and the approval-gate stack test caught the difference. The driver now creates the parent (recursive,
skipped for `:memory:`), so the bump changes nothing a caller can see. A failure to create it is not
reported from there — the open names the real reason.

**The schema.** `MemoryGraph.initSchema()` used to swallow **every** schema error with
`catch { /* ignore already-exists */ }`, so a read-only file, a full disk or an unopenable database
produced a graph that accepted no writes and silently read back nothing. `IF NOT EXISTS` makes the
expected case a success, so the catch now tolerates only `/already exists/i` and rethrows the rest.
F2: the distinction is pinned by `schema-setup.test.ts`, which supplies a driver whose DDL fails on
cue (a real Kùzu cannot be asked to) — the rethrow, the tolerance, and setup running once. Restore
the swallow-all catch and the first test fails. This is why `MemoryGraph`'s constructor takes an
optional `GraphDriver`: the failure path has no other way to be exercised.

**Table setup starts with the first query, not the constructor (F15).** The constructor used to
start the DDL sequence immediately. `buildRunStack` can fail at once after constructing the graph
(a typed `--policy` naming no file), so `close()` could run between two DDL statements: the driver
released the database, the next statement threw, and the caller's `rm` raced handles that were not
yet closed — `ENOTEMPTY … memory.kuzu`, measured at 1 in 20 on the base branch and 6 in 60 under
load. Setup is now lazy: `ensureSchema()` starts it once, and every query awaits it. A graph that
is opened and closed without a query runs no DDL at all, so the close is deterministic. The
regression test opens and removes 60 graphs in a row; the M1 stack-cleanup test ran 20/20 after the
change.

**The transfer.** `packages/memory-graph/src/GraphTransfer.ts` (new) is the version-neutral half:
`exportGraph` reads nodes and edges ordered by id and writes plain JSON; `parseGraphExport`
validates a file before anything is written; `importGraph` refuses a non-empty target, writes inside
`BEGIN TRANSACTION`/`COMMIT` (best-effort `ROLLBACK` on failure) and compares the final node and
edge counts to the file. Nothing in the format is Kùzu-specific beyond the two read queries, so a
later importer for another backend reads the same file.

The file is `{ format: "maf-graph", formatVersion: 1, kuzuVersion, exportedAt, nodes[], edges[] }`.
A node carries `id, kind, label, properties, runId, createdAt, updatedAt`; an edge carries
`id, fromId, toId, relation, weight, metadata, createdAt`. Properties and metadata are JSON objects,
not escaped strings. A stored blob that is not JSON aborts the export rather than becoming `{}`: a
rescue tool must not lose the row it exists to carry.

**The command.** `packages/cli/src/commands/graph.ts` (new) registers:

- `maf graph export [-d <dir>] [--db <path>] [-o <file>]` — defaults `.maf/memory.kuzu` and
  `<dir>/graph-export.json`; writes the file with mode `0600` because it holds task titles, file
  paths and failure messages.
- `maf graph import <file> [-d <dir>] [--db <path>]` — `--db` must name a fresh database; the
  refusal names the count and suggests `--db`.

**The guard.** Opening a 0.7.x directory now fails with a `GraphOpenError` whose message names the
path, says what the graph holds, and gives the one command that keeps it:

> The graph at <path> was written by Kùzu 0.7.x, and this maf uses Kùzu 0.11.3, which cannot read
> the older format (Kùzu changed it before 1.0). It holds this repository's recall history — the
> failures and plans earlier runs recorded — and nothing else: your code, branches and attestations
> live elsewhere and are unaffected, and a new graph simply starts empty. To keep the old one and
> let maf start a new graph, run:
>
>     mv <path> <path>.0.7-backup
>
> maf does not move or delete it for you. Original error: …

(U1, the architect's ruling. The message this replaced printed an export-then-import route that no
installed maf could carry out: no released version has `graph export`, and this Kùzu cannot read
the format it would have to export. The export step is gone; the refusal is not — maf will not move
or delete the user's file.)

`maf graph export` on such a database exits non-zero and prints that message on stderr; it does not
write an empty file.

**The exporter refuses what the importer would refuse (F1).** `exportGraph` checks every row against
the import's own rules — non-empty `id`, `kind`, `label`, `runId`, `createdAt`, `updatedAt`; a
non-empty `id`, `fromId`, `toId`, `relation`, `createdAt` and a finite `weight` on an edge — and
stops on the first bad row with a `GraphTransferError` naming the row and the field. The check runs
before the export object is returned, so no caller has a file to write: an export the importer would
reject is not an export.

**A missing database is a failure (F3).** `maf graph export --db <path>` on a path that holds no
graph exits non-zero with `no graph at <path>` and creates nothing — not the export file, not the
database, not its parent directory. Opening the path instead would create an empty database and
write a file that reads like a successful rescue of nothing.

## Follow-up — `close()` resolves only after the release

The finding, measured at `6beab28` on Linux with Node 22: **10 processes × 60 cycles failed in 3 of
the 10 processes**, each with `ENOTEMPTY … memory.kuzu`; the same 600 cycles run one process at a
time failed in none. `KuzuDriver.close()` was synchronous and returned at once. When anything was in
flight — the `conn.init()` every constructor starts, a query, a schema statement — the release was
deferred, so the caller's `rm` ran against a directory whose native handles were still open.

Ruling: fix the cause, not the caller. **`close(): Promise<void>`** now resolves only after `ready`
(that `init()`) has settled, no work is in flight, and both `await conn.close()` and `await
db.close()` have completed — connection first, then database, as the buffer-manager rule requires.
A second `close()` returns the same promise, and a query issued after it is refused at once rather
than queued behind the release. The wait is a counter plus an idle-waiter list (`track()` /
`whenSettled()`), not a poll: there is no deadline, so nothing here is timing-dependent. `run()`
still refuses immediately on the `closed` flag.

**`MemoryGraph.close()` is a promise too**, and awaits `schemaReady` before it releases the driver.
That is not belt-and-braces: the schema sequence has idle gaps between its statements, so the
driver's in-flight count passes through zero between two of them, and a driver-only close would
release the database under the statement that follows.

**Every caller awaits it — nothing enforces that.** `MemoryGraphApi.close()` in `@maf/types`
carries the promise under a `// WP-3.8 follow-up` header. Every caller awaits it today: the
`graph`, `goldens`, `run`, `evolve` and `inprocess-demo` commands, the `merge` command in
`main.ts` (line 79), `RunStack.close()` in `wiring.ts` (including the setup-failure path), and
every test that closes a graph. But the type does not make a caller await it: an unawaited
`close()` type-checks (the verifier's mutant dropped one at `graph.ts:51` and `tsc` exited 0), and
the promise is then simply discarded. This repo has no eslint config, so there is no
floating-promise lint rule to run. Proposed to CJ under WP-3.12 —
`@typescript-eslint/no-floating-promises` — which would make the unawaited form an error; it is
**not** added here.

`wiring.ts` keeps its `try`/`catch` close — the release is in the `catch`, not a `finally`. The
reason is the leak, not `ENOTEMPTY`: a setup that fails after the graph is constructed must still
release the handle, or the address-space reservation and the native work keep running under the
`mafDir` that the caller removes next. The success path closes through the `RunStack` the caller
holds. The comment there says both.

**Before and after, same protocol.** 10 processes × 60 cycles: **3 of 10 failed before, 0 of 10
after.** The regression tests are retry-free and observe ordering, not duration:

| Pin | Test |
|---|---|
| the promise resolves after the connection and then the database have closed, and a `close()` that resolves first is red | `native-lifetime.test.ts` — patches both native `close` methods to record `conn:begin/end`, `db:begin/end` and asserts that exact sequence before `close:resolved`; the early-resolve mutant was run against it and fails it |
| `close()` during `init()` | the same file — `init()` is held open, `close()` must not have resolved, then it must |
| `close()` during a query | the same file — the query is held open, completes, and its row is on disk in a re-opened graph |
| `close()` between two schema statements | the same file — the sequence is held mid-flight, and no statement meets a released database |
| four processes closing and removing at once, 30 cycles each | the same file — the M1 shape as a **smoke test**, not a regression pin: the child opens, closes and removes with no query, so `init()` is in flight at `close()`. Measured on base `60e93e5` with Kùzu 0.11.3 on macOS **and** Linux: it **passes**. `ENOTEMPTY` was a 0.7.x property — the database was a directory then; 0.11.3 writes one file, and both platforms unlink an open file, so the race leaves no error and this test cannot go red. The regression is pinned by the three rows above |

### Round 2 — the graph waits for its own operations, and a failed release fails the close

Two holes the first round left.

**`MemoryGraph` counts its own public operations (C2).** Waiting on the driver's in-flight count was
not enough: a query issued before `close()` but still awaiting schema setup is invisible to the
driver, so the graph released underneath it and the query was refused instead of finishing; a
`querySubgraph` between its node query and its edge query was cut off the same way, silently
returning edges 0. Every public method now enters through `track()` — the count is incremented
synchronously, before the method touches `ensureSchema`, so an operation that has passed the
`closed` check is always counted — and `close()` waits for the count to reach zero before awaiting
the driver's close. `close()` itself is memoised (`closePromise ??=`), and a call made after it is
refused at once by the `closed` flag.

**`release()` swallows only what cannot be acted on (C4).** Both native closes are attempted on
every path, connection first. If `init()` failed there is nothing native to free — that error was
already delivered through `ready` — so the close resolves. Otherwise a native close error
**rejects** the close, naming which handle failed and carrying the first error as `cause`: a caller
in a `finally` must not remove the directory of a database that did not close. `close()` also has
no deadline, stated as a known property in its JSDoc: a native query that never settles keeps it
pending (C9).

Tests: a query issued just before `close()` resolves with its real rows and the next is refused; an
in-flight `querySubgraph` returns real edges; a database close that throws rejects with the message
above while the connection is still released first; a connection whose `init()` failed releases in
order and resolves. Removing the graph's in-flight wait turns the first two red; resolving the
driver's `close()` before the release turns six of the thirteen tests in the file red (3, 5, 6, 7,
11, 12) — the exact list and the logs are in the PR body.

## Acceptance

| WP-3.8 acceptance | Where it is discharged |
|---|---|
| `maf graph export` writes nodes and edges as JSON | `packages/cli/src/__tests__/graph-cli.test.ts` — import → export through the built CLI, then the file's `format`, `formatVersion`, `kuzuVersion`, 4 nodes and 3 edges are asserted |
| `import` restores them into a fresh database and a query returns the same rows | `packages/memory-graph/src/__tests__/graph-transfer.test.ts` — round trip with a 3-node/2-edge graph (property, timestamp and `0.5` weight equality), and the committed 0.7.1 export imported on 0.11.3 with `recallFailures` by title and by path returning the committed rows |
| opening a 0.7-format database names the path, says what it held, gives the `mv` command and exits non-zero | `graph-transfer.test.ts` (each clause of the `GraphOpenError` message, and that no `graph export`/`graph import` appears in it) and `graph-cli.test.ts` (exit code, stderr, no output file, the old graph still in place) |
| the four real-Kùzu tests pass on 0.11.3 | 37/37 across `failure-recall`, `graph-parameters`, `native-lifetime`, `query-subgraph`, `no-escaper`, `graph-transfer` and `schema-setup` — 32 unchanged, one rewritten in place (the 0.7.x refusal, now the `mv` message), 4 added (three in `schema-setup.test.ts`, one export-invariant test) |
| `db.close()` is called and does not crash | `graph-transfer.test.ts` — a closed graph is a single file with no `.wal` beside it and reopens with its rows; the existing native-lifetime tests (20 opens, GC child, in-flight close) pass on 0.11.3 |

New tests also pin: a non-empty target is refused before any write; a file from a newer
`formatVersion` is refused with "Upgrade maf"; duplicate ids, an edge to a missing node, an empty id
and a non-finite weight are refused with the row named; an import that fails halfway rolls back and
the graph is usable afterwards; and an export taken immediately after writes, with the graph still
open, returns every row — the export reads through the engine, never by copying a file, so the D2
checkpoint-before-copy rule is not on this path.

## Decision

**D-58 · The graph moves by export/import, not by compatibility.** Kùzu promised no file-format
compatibility before 1.0, and measured here: 0.7.1 writes a directory, 0.11.3 writes a single file,
and 0.11.3 cannot open the directory (`Database path cannot be a directory` at `conn.init()`). The
migration is therefore explicit: export to version-neutral JSON from a maf that can read the graph,
then import into a fresh graph with this maf. Import refuses a non-empty target rather than merging
(merge is a separate operation with its own decision), refuses a file whose format it does not know,
and validates every row before writing. **Rejected — keep 0.7.1** (D-51: 0.11.3 is the final release
and the version the graph-lifecycle fixes target). **Rejected — a compatibility shim** (there is no
reader for the old format in 0.11.3 to shim). **Rejected — a file copy as the migration** (the
storage layout is exactly what changed, and a stale `.wal` beside a restored database replays onto it
— the D2 rule recorded in the plan).

## Ruling — a 0.5.x memory graph is not carried into 0.6.0

The plan's ordering constraint was that `graph export` ship **while maf is on 0.7.x**, so that an
existing graph could be exported by the version that wrote it. No released maf carries `graph
export`: 0.5.0 (the last source release) predates this work, and this branch bumps to 0.11.3 in the
same change. The committed `fixtures/kuzu-0.7.1-export.json` was generated by running the new
exporter on 0.7.1 **before** the bump, which proves the artifact, but it cannot retroactively give
0.5.0 the command.

**U1, the maintainer's ruling:** a memory graph from 0.5.x or earlier is **not** carried into
0.6.0. The graph holds recall history — the failures and plans earlier runs recorded — and nothing
else; code, branches and attestations live elsewhere and are unaffected. The message above is the
whole upgrade path: it says the new graph starts empty and gives the one command that sets the old
one aside. No exporter is added to the old Kùzu: shipping one would be a feature in a patch release.

0.6.0 release-note line: *"Upgrading from 0.5.x: the memory graph starts empty; maf tells you the
one command to keep the old one aside."*

## Files outside the WP row's ownership (F5)

`packages/cli/src/main.ts` (+2 lines, to register the `graph` command) and the new command test
`packages/cli/src/__tests__/graph-cli.test.ts` are not in WP-3.8's file list. Both are required by it:
the command does not exist for a user until it is registered, and the process-level behaviour (exit
code, the sentence on stderr, no file written) is not observable from the memory-graph package. No
other file outside the row's ownership changed.

## Fixtures

- `packages/memory-graph/src/__tests__/fixtures/kuzu-0.7.1.tar.gz` — a real 0.7.1 database
  directory (`memory.kuzu/`, checkpointed, empty `.wal`) holding one run's Task → Failure and
  Task → File rows. It is the "old graph on disk" the guard must refuse.
- `packages/memory-graph/src/__tests__/fixtures/kuzu-0.7.1-export.json` — that same database
  exported by `maf graph export` while the repository was still on 0.7.1:

  ```
  node packages/cli/dist/main.js graph export \
    --db /tmp/<scratch>/memory.kuzu --out packages/memory-graph/src/__tests__/fixtures/kuzu-0.7.1-export.json
  ```

  Output: `Exported 4 nodes and 3 edges to … (Kùzu 0.7.1, graph format 1).`

Both are read from `src/__tests__/fixtures` by the tests (the tests run from `dist`, and `tsc` does
not copy non-TypeScript files), the same arrangement the attestation bundle test uses.
