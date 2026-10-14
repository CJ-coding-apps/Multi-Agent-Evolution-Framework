import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlackboardStore } from '@maf/blackboard';
import { DagRunner, DagParser, createWriterLockLedger } from '@maf/dag-runner';
import { createDefaultRegistry } from '@maf/tools';
import { mintHarnessConfig } from '@maf/harness-config';
import { runIsolatedGit } from '@maf/git-ops';
import { DEFAULT_ROLE_SET, RoleDispatcher, RoleRegistry, defineRoleName } from '@maf/roles';
import type { Attestor } from '@maf/attestation';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AssistantTurn,
  AttributedChange, BlackboardValue, ExecutionTierRecord, ModelSurfaceRecord, ToolResult,
  TurnAdapter, TurnMessage, WriterLockLedger,
} from '@maf/types';
import { makeRunId } from '@maf/types';
import { writerLock } from '../commands/run.js';

// ORACLE (WP-3.0c, F1 of the 3.0c review). The spec's test for the F7 window, in the shape a
// verifier ran it: a REAL DagRunner, a REAL RoleDispatcher, ONE shared ledger, the built-in `coder`
// and `analyst`, maxConcurrent 2. The coder writes `feature.ts` and keeps holding the writer lock
// across the analyst's turn; the analyst's bracket sees the change and must attribute it to the
// coder's gate instead of failing the reader. The first version of this evidence was a stub ledger
// the production path never consults, so four mutations that break `maf run`'s attribution passed
// the whole suite. Each is killed here, and each kill was measured, not asserted:
//   M1 — the runner never releases the writer lock (DagRunner's `exit` removed): the sequential
//        case, whose reader starts after the coder has settled, stops failing. Measured: test 2 red.
//   M2/M3 — run.ts builds a second ledger, or a fresh one, for the dispatcher: the two ends are no
//        longer the same object. Measured: test 3 red on its first assertion.
//   M8 — the runner's bracket readings are not handed to the ledger (window `(0, endedAt)`, or a
//        wall clock in place of `performance.now()`): the pin and the attribution both fall over.
//        Measured: tests 1 and 2 red.
//   M8b — the window is a degenerate point `[to+1, to+1]` rather than the bracket: a point still
//        overlaps an *open* hold, so the width has to be checked strictly. Measured: test 1 red on
//        `to > from`.
//
// The F2 rule this exercises lives in RoleDispatcher.attributableWriter: a change is excused only by
// a writer still holding the lock, or one whose reviewed diff carries every path the reader's
// bracket showed. Nothing else does — the "a writer overlapped, so excuse the reader" mutation is
// pinned in the roles package, where the ledger is a stub the test can shape directly.

const IN_PROCESS_CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 4, nativePlugins: [],
};

const BASE_TOOLS = createDefaultRegistry();

// ─── a tiny deferred, so the two nodes overlap by construction, not by timing ────────────────

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCoderTurn(opts: AdapterInvokeOptions): boolean {
  return (opts.systemPrompt ?? '').includes('Coder agent');
}

/**
 * The built-in `coder` and `analyst` behind a timed adapter. The coder's first turn waits until the
 * analyst has opened its bracket (its first `sendTurn`), then writes `feature.ts` through the gate;
 * its second turn releases the analyst and keeps holding the lock for `holdMs` more, so the
 * analyst's guard runs while the coder is still the holder. Every ordering the test depends on is a
 * promise resolution, not a sleep — `holdMs` is only margin.
 */
class OverlapAdapter implements TurnAdapter {
  readonly name = 'overlap';
  private readonly coderWrote = deferred();
  private readonly analystReady = deferred();
  private coderTurns = 0;
  constructor(private readonly holdMs: number) {}
  capabilities(): AdapterCapabilities { return IN_PROCESS_CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    if (isCoderTurn(opts)) {
      this.coderTurns += 1;
      if (this.coderTurns === 1) {
        await this.analystReady.promise; // the analyst's bracket is open before the coder writes
        return {
          text: 'writing the feature',
          toolCalls: [{ toolUseId: 'w1', toolName: 'fs.write', input: { path: 'feature.ts', content: 'export const feature = 1;\n' } }],
        };
      }
      this.coderWrote.resolve(); // the write has executed; the analyst may close its turn
      await sleep(this.holdMs);  // and the coder keeps holding the lock across the analyst's guard
      return { text: 'wrote feature.ts', toolCalls: [] };
    }
    this.analystReady.resolve();
    await this.coderWrote.promise;
    return { text: 'the feature is there', toolCalls: [] };
  }
}

/** The built-in coder writes `feature.ts`; the analyst, running after it, plants a change of its own. */
class PlantAdapter implements TurnAdapter {
  readonly name = 'plant';
  private coderTurns = 0;
  capabilities(): AdapterCapabilities { return IN_PROCESS_CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    if (isCoderTurn(opts)) {
      this.coderTurns += 1;
      if (this.coderTurns === 1) {
        return {
          text: 'writing the feature',
          toolCalls: [{ toolUseId: 'w1', toolName: 'fs.write', input: { path: 'feature.ts', content: 'export const feature = 1;\n' } }],
        };
      }
      return { text: 'wrote feature.ts', toolCalls: [] };
    }
    await writeFile(path.join(opts.workingDir, 'sneaky.txt'), 'planted by the reader\n', 'utf8');
    return { text: 'investigated the code', toolCalls: [] };
  }
}

/**
 * V1's ordering: a coder that writes `feature.ts` and *finishes* — lock released, gate run — while
 * the analyst's bracket is still open. The analyst's guard therefore runs with no holder (rule (a)
 * cannot excuse it) and, because the coder's gate already ran for this attempt, must be excused by
 * rule (b): the path the bracket shows still carries, in the analyst's end tree, what the coder's
 * gate tree recorded. The analyst waits on the coder's *node end* so the gate has certainly run —
 * the bracket closes after the writer exited, which is the ordering a plain `sleep` cannot pin.
 */
class FinishedCoderAdapter implements TurnAdapter {
  readonly name = 'finished-coder';
  private readonly analystReady = deferred();
  private coderTurns = 0;
  constructor(private readonly coderEnded: Deferred) {}
  capabilities(): AdapterCapabilities { return IN_PROCESS_CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    if (isCoderTurn(opts)) {
      this.coderTurns += 1;
      if (this.coderTurns === 1) {
        await this.analystReady.promise; // the bracket is open before the write, so it shows the change
        return {
          text: 'writing the feature',
          toolCalls: [{ toolUseId: 'w1', toolName: 'fs.write', input: { path: 'feature.ts', content: 'export const feature = 1;\n' } }],
        };
      }
      return { text: 'wrote feature.ts', toolCalls: [] };
    }
    this.analystReady.resolve();
    await this.coderEnded.promise; // the coder's node has ended — lock released and gate run
    return { text: 'the feature is there', toolCalls: [] };
  }
}

/**
 * V4: two coders overlap the analyst's bracket and only the *second* touched the path the bracket
 * shows. `code1` edits `app.js`; `code2` puts `app.js` back to its base content and writes the new
 * `feature.ts`. The bracket therefore shows exactly one path — `feature.ts` — which `code1` never
 * reviewed but `code2` did, and `attributedTo` must name the second, `code2`. (`code1` must change
 * *something*, or a role that expects a change and makes none fails with `no_change` and the
 * dependent `code2` never runs — the reader would then wait on a node end that never comes.) The
 * analyst waits on `code2`'s node end, so both coder intervals lie inside its bracket by
 * construction, and `code1` opens the bracket before writing so the reverted path stays out of it.
 */
class TwoCodersAdapter implements TurnAdapter {
  readonly name = 'two-coders';
  private readonly analystReady = deferred();
  private coderTurns = 0;
  constructor(private readonly secondCoderEnded: Deferred) {}
  capabilities(): AdapterCapabilities { return IN_PROCESS_CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    throw new Error('every role here runs the in-process loop');
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(_h: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    if (isCoderTurn(opts)) {
      this.coderTurns += 1;
      switch (this.coderTurns) {
        case 1: // code1: open the bracket first, then edit app.js
          await this.analystReady.promise;
          return { text: 'editing app.js', toolCalls: [{ toolUseId: 'c1', toolName: 'fs.write', input: { path: 'app.js', content: 'module.exports = () => 2;\n' } }] };
        case 2:            // code1 done
          return { text: 'edited app.js', toolCalls: [] };
        case 3:            // code2: put app.js back to base — this path must leave the bracket
          return { text: 'reverting app.js', toolCalls: [{ toolUseId: 'c2', toolName: 'fs.write', input: { path: 'app.js', content: 'module.exports = () => 1;\n' } }] };
        case 4:            // code2: the path the bracket will show
          return { text: 'writing the feature', toolCalls: [{ toolUseId: 'c3', toolName: 'fs.write', input: { path: 'feature.ts', content: 'export const feature = 1;\n' } }] };
        default:           // code2 done
          return { text: 'wrote feature.ts', toolCalls: [] };
      }
    }
    this.analystReady.resolve();
    await this.secondCoderEnded.promise;
    return { text: 'the feature is there', toolCalls: [] };
  }
}

// ─── the harness the dispatcher needs, with a real recorder for the two arrays under test ─────

function makeTranscript() {
  const entries: Array<{ role: string; content: string; metadata: Record<string, unknown> }> = [];
  const stub: Pick<TranscriptLogger, 'append'> = {
    append: async (role, content, metadata = {}) => { entries.push({ role, content, metadata }); },
  };
  return { entries, stub: stub as unknown as TranscriptLogger };
}

function makeAttestor() {
  const diffHashes: Array<{ key: string; diff: string }> = [];
  const tiers: ExecutionTierRecord[] = [];
  const surfaces: ModelSurfaceRecord[] = [];
  const attributed: AttributedChange[] = [];
  return {
    diffHashes, tiers, surfaces, attributed,
    stub: {
      record: async (_c: { toolId: string; result: ToolResult }) => undefined,
      recordDiffHash: (key: string, diff: string) => { diffHashes.push({ key, diff }); },
      recordExecutionTier: (record: ExecutionTierRecord) => { tiers.push(record); },
      recordModelSurface: (record: ModelSurfaceRecord) => { surfaces.push(record); },
      recordAttribution: (record: AttributedChange) => { attributed.push(record); },
    } as unknown as Attestor,
  };
}

/** A ledger that answers exactly as the real one would, and remembers the windows it was asked. */
function spyingLedger(inner: WriterLockLedger) {
  const windows: Array<{ from: number; to: number }> = [];
  const ledger: WriterLockLedger = {
    enter:             (id) => inner.enter(id),
    exit:              (id) => inner.exit(id),
    isHolding:         (id) => inner.isHolding(id),
    writersOverlapping: (from, to) => { windows.push({ from, to }); return inner.writersOverlapping(from, to); },
  };
  return { ledger, windows };
}

interface Fixture {
  run: (deps: {
    ledger: WriterLockLedger;
    adapter: TurnAdapter;
    /** Extra observer on node end, alongside the dispatcher's own `endNode` (V1/V4 order the turns). */
    onNodeEnd?: (id: string) => void;
  }) => Promise<{ status: string }>;
  cwd: string;
  transcript: ReturnType<typeof makeTranscript>;
  attestor: ReturnType<typeof makeAttestor>;
  cleanup: () => Promise<void>;
}

/**
 * A repository with one commit, a DAG of the two built-in roles, and a run wired as `maf run` wires
 * it. `nodes`, when given, replaces the default two-node DAG (V4 needs two coder nodes).
 */
async function makeFixture(
  nodeDeps: string[],
  nodes?: Array<{ id: string; label: string; agentRole: string; dependencies?: string[] }>,
): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'maf-attribution-'));
  await writeFile(path.join(cwd, 'app.js'), 'module.exports = () => 1;\n', 'utf8');
  await runIsolatedGit(cwd, ['init', '-q']);
  await runIsolatedGit(cwd, ['add', '-A']);
  await runIsolatedGit(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);

  const roles = RoleRegistry.fromSet(DEFAULT_ROLE_SET, cwd, BASE_TOOLS);
  const transcript = makeTranscript();
  const attestor = makeAttestor();
  const runId = makeRunId('attribution');
  const harness = mintHarnessConfig({
    id: 'attribution-test',
    roleSet: { version: 1, defaultRole: defineRoleName('coder'), roles: [{ role: defineRoleName('coder'), allowedTools: ['fs.write'], execution: 'in-process' }] },
    processorBundles: [{ name: 'transcript' }, { name: 'policy-audit' }],
  });

  const dag = DagParser.fromSpec(
    { id: 'x', config: { maxConcurrent: 2 }, nodes: nodes ?? [
      { id: 'code', label: 'implement the feature', agentRole: 'coder' },
      { id: 'ask',  label: 'investigate the feature', agentRole: 'analyst', dependencies: nodeDeps },
    ] },
    runId,
    roles,
  );

  return {
    cwd, transcript, attestor,
    run: async ({ ledger, adapter, onNodeEnd }) => {
      const dispatcher = new RoleDispatcher({
        adapter,
        baseTools:    BASE_TOOLS,
        roles,
        injector:     { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
        policy:       { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
        attestor:     attestor.stub,
        graph:        { addNode: async () => undefined } as unknown as MemoryGraph,
        transcript:   transcript.stub,
        lcmBridge:    { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
        cwd,
        sessionId:    's-attribution',
        runId,
        harness,
        writerLockLedger: ledger,
      });
      const outcome = await new DagRunner().run({
        dag,
        board:            new BlackboardStore(),
        executor:         (node) => dispatcher.runNode(node),
        // The predicate `maf run` builds: the registry, the adapter and the tool registry decide,
        // not the test — the same `writerLock` run.ts hands the runner.
        isWriter:         writerLock(roles, adapter, BASE_TOOLS),
        writerLockLedger: ledger,
        onNodeEnd:        (id) => { dispatcher.endNode(id); onNodeEnd?.(id); },
      });
      return { status: outcome.status };
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test('F1: a slow coder overlapping the analyst — the analyst succeeds and the change is attributed to the coder', async () => {
  const f = await makeFixture([]);
  const { ledger, windows } = spyingLedger(createWriterLockLedger());
  const startedAt = performance.now();
  try {
    const { status } = await f.run({ ledger, adapter: new OverlapAdapter(1000) });

    assert.equal(status, 'Succeeded', 'the reader is not failed for a change a writer took to a gate');

    assert.equal(f.attestor.attributed.length, 1, 'exactly one attribution');
    const attributed = f.attestor.attributed[0];
    assert.equal(attributed?.nodeId, 'ask', 'the reader whose bracket showed the change');
    assert.equal(attributed?.attributedTo, 'code', 'named to the writer — the coder — whose lock covered the turn');

    const coderDiff = f.attestor.diffHashes.find((h) => h.key === 'code.diff');
    assert.ok(coderDiff, 'the coder ran its post-coder gate and its diff is a subject of the run');
    assert.match(coderDiff.diff, /feature\.ts/, 'and that gated diff holds the file the reader saw');
    assert.equal(f.attestor.diffHashes.some((h) => h.key === 'ask.diff'), false, 'the change is not charged to the reader');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'ask.attributed.diff'), 'the bracket diff is a subject instead');

    // The window argument pinned (M-no-window): one question, asked with the bracket's own two
    // monotonic readings — inside the run, ordered, and no wider than the run itself. `to > from`
    // (strict) is what kills M8b, the degenerate `[to+1, to+1]`: a single instant still overlaps an
    // open hold, so only a *strict* ordering shows the window is the bracket and not a point.
    assert.equal(windows.length, 1, 'the ledger is asked once, for the one reader');
    const window = windows[0]!;
    assert.ok(window.from >= startedAt, 'the window opens at the reader\'s bracket, not at zero or a wall clock');
    assert.ok(window.to > window.from, 'the window spans the bracket (kills M8b: `[to+1, to+1]` is a point)');
    assert.ok(window.to <= performance.now(), 'and not in the future');
  } finally {
    await f.cleanup();
  }
});

test('F1: the sequential case — a coder that finished long ago does not excuse the analyst\'s own change', async () => {
  // The reader depends on the coder, so the coder's hold is fully closed before the reader's bracket
  // opens: the ledger names no overlapping writer, and the change the reader plants fails it. If the
  // runner never released the lock (M-exit), the closed hold would read as still-open and the reader
  // would be excused — this is the case that catches it.
  const f = await makeFixture(['code']);
  const { ledger } = spyingLedger(createWriterLockLedger());
  try {
    const { status } = await f.run({ ledger, adapter: new PlantAdapter() });

    assert.equal(status, 'Failed', 'the analyst changed the tree and no writer accounts for it');
    assert.equal(f.attestor.attributed.length, 0, 'no attribution — the only overlapping writer never overlapped');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'ask.diff'), 'the change is recorded as the reader\'s own');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'code.diff'), 'and the coder still ran its gate on its own change');
  } finally {
    await f.cleanup();
  }
});

test('F1/V1: a coder that FINISHED inside the bracket still excuses it — rule (b), not the lock', async () => {
  // The ordering V1 exercises: the coder's lock is released and its gate has run before the analyst
  // closes, so rule (a) cannot apply (a gated writer is never a holder for this purpose) and the
  // attribution must come from rule (b) — the coder's gate tree still carries the bracket's path.
  const f = await makeFixture([]);
  const { ledger, windows } = spyingLedger(createWriterLockLedger());
  const coderEnded = deferred();
  try {
    const { status } = await f.run({
      ledger, adapter: new FinishedCoderAdapter(coderEnded),
      onNodeEnd: (id) => { if (id === 'code') coderEnded.resolve(); },
    });

    assert.equal(status, 'Succeeded', 'a finished, gated coder answers for the path its gate reviewed');
    assert.equal(f.attestor.attributed.length, 1, 'exactly one attribution');
    const attributed = f.attestor.attributed[0];
    assert.equal(attributed?.nodeId, 'ask', 'the reader whose bracket showed the change');
    assert.equal(attributed?.attributedTo, 'code', 'named to the finished coder');
    assert.equal(f.attestor.diffHashes.some((h) => h.key === 'ask.diff'), false, 'the change is not charged to the reader');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'ask.attributed.diff'), 'the bracket diff is a subject instead');
    assert.equal(windows.length, 1, 'the ledger was asked once for the one reader');
  } finally {
    await f.cleanup();
  }
});

test('F1/V4: two coders overlap the bracket and the SECOND wrote — the attribution names the second', async () => {
  // `code1` runs, changes nothing, so its reviewed diff is empty and it can answer for no path;
  // `code2` reviewed the one path the bracket shows. The ledger lists both (closed, oldest first);
  // `attributedTo` must be `code2`, the writer whose reviewed diff actually holds the change, not
  // the first overlapping writer it happens to list.
  const f = await makeFixture([], [
    { id: 'code1', label: 'implement part one', agentRole: 'coder' },
    { id: 'code2', label: 'implement part two', agentRole: 'coder', dependencies: ['code1'] },
    { id: 'ask',   label: 'investigate the feature', agentRole: 'analyst' },
  ]);
  const { ledger } = spyingLedger(createWriterLockLedger());
  const secondCoderEnded = deferred();
  try {
    const { status } = await f.run({
      ledger, adapter: new TwoCodersAdapter(secondCoderEnded),
      onNodeEnd: (id) => { if (id === 'code2') secondCoderEnded.resolve(); },
    });

    assert.equal(status, 'Succeeded', 'the second coder accounts for the change the reader saw');
    assert.equal(f.attestor.attributed.length, 1, 'exactly one attribution');
    assert.equal(f.attestor.attributed[0]?.nodeId, 'ask', 'the reader whose bracket showed the change');
    assert.equal(f.attestor.attributed[0]?.attributedTo, 'code2', 'named to the SECOND coder — the one that wrote');
    // `code1` gated too (its diff is a subject), which is exactly why the path check, not mere
    // overlap, is what selects the writer.
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'code1.diff'), 'the first coder ran its gate');
    assert.ok(f.attestor.diffHashes.some((h) => h.key === 'code2.diff'), 'and so did the second');
  } finally {
    await f.cleanup();
  }
});

test('F1: run.ts hands ONE ledger to both the runner and the dispatcher (kills M2/M3)', async () => {
  // A source-level assertion because the wiring is the whole point: the runner stamps the ledger the
  // dispatcher reads. Two ledgers — one built for the dispatcher, or a fresh one at the call site —
  // is a second home, and the dispatcher would ask a ledger nothing ever stamped. The CLI has no way
  // to observe both ends of a real overlap without a live model, so the wiring is checked as written.
  //
  // NOTE (N3, 3.0c review): this is a *source-level* pin — identifier counts plus call-site order — and
  // it is the only pin for M2/M3. A behavioural check would drive `run` through `driveRun` with an
  // adapter that interleaves a writer and a reader and assert the resulting bundle carries an
  // `attributedChanges` entry, which can only appear if the two ends share one ledger. It is left
  // undone under the review's time-box: `run.ts` builds the ledger itself with no injection point, so
  // the behavioural check needs the real `run` path (harness minting, roles, worktree, LCM) plus a
  // deferred-interleaving adapter, which is not an hour's work and is timing-fragile besides. If the
  // wiring shape ever changes, this test must change with it; it does not by itself prove the runtime.
  const runTs = path.join(__dirname, '..', '..', 'src', 'commands', 'run.ts');
  const src = await readFile(runTs, 'utf8');

  assert.equal((src.match(/createWriterLockLedger\(\)/g) ?? []).length, 1,
    'run.ts builds exactly one ledger; a second is a ledger the runner never stamps');
  assert.equal((src.match(/writerLockLedger/g) ?? []).length, 3,
    'one declaration and the two handoffs — the dispatcher\'s and the runner\'s');

  const dispatcherAt = src.indexOf('new RoleDispatcher(');
  const runnerAt     = src.indexOf('const dagRunner = new DagRunner();');
  assert.ok(dispatcherAt >= 0 && runnerAt > dispatcherAt, 'both call sites exist, in that order');
  const dispatcherHandoff = src.indexOf('writerLockLedger', dispatcherAt);
  const runnerHandoff     = src.indexOf('writerLockLedger', runnerAt);
  assert.ok(dispatcherHandoff > dispatcherAt && dispatcherHandoff < runnerAt,
    'the dispatcher is handed the ledger (not a fresh one at its call site)');
  assert.ok(runnerHandoff > runnerAt && runnerHandoff < runnerAt + 1000,
    'and so is the runner');
});
