import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AssistantTurn, CliAdapter,
  TurnAdapter, TurnMessage,
} from '@maf/types';
import { LcmEngine } from '@maf/lcm';
import { runTask } from '../commands/run.js';
import type { GivenFlag, RunOptions } from '../commands/run.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { collector, needsLcm, registryOf } from './runFixture.js';

// ORACLE: WP-3.2 round 2, R1 — the user's path. Every other LCM test drives `buildRunStack` or a
// component; this one drives `maf run` itself (`runTask`), because a second copy of the LCM wiring
// in `run.ts` is how seven mutants survived round 1. There is one factory now (`createRunLcm`), and
// this test dies when any of the seven inputs `run.ts` gives it is dropped or altered:
//
//   K1 mafDir      — the archive is opened under the run's `.maf/`, so it can be expanded from the
//                    same path afterwards (and the bundle is written beside it)
//   K2 cwd         — the summarization call runs in the run's working directory
//   K3 adapter     — the summary is made by the adapter the run resolved, not a fresh one
//   K4 model       — the model the run was given is the summarization model when `lcm.model` is
//                    absent (`lcm.model` wins when present; that precedence is pinned in
//                    lcm-config.test.ts and run-lcm-wiring.test.ts)
//   K5 lcm config  — mode, operator, threshold, tail and timeout all reach the engine
//   K6 sessionId   — the archive belongs to this run; another run's id cannot expand it
//   K7 attestor    — the call and the settings in force are in *this run's* bundle
//
// Names are K-prefixed so they cannot be mistaken for the verifier's mutant ids.

const SUMMARY_TEXT = 'Node one read the sum module and reported that it subtracts.';
const REPORTED_TOKENS = 42;
const ROLE_BUDGET = 10_000;
const SUMMARY_TIMEOUT_MS = 4_321;

const PLAN = [
  'Here is the plan.',
  '```json',
  JSON.stringify({
    nodes: [
      { id: 'n1', label: 'node one', description: 'node one', agentRole: 'analyst' },
      { id: 'n2', label: 'node two', description: 'node two', agentRole: 'analyst', dependencies: ['n1'] },
    ],
  }),
  '```',
].join('\n');

const CONFIG = `adapter: round-two-recorder
model: run-model
worktree: false
lcm:
  mode: Upward
  operator: agentic-map
  contextThreshold: 0.001
  freshTailCount: 1
  summaryTimeoutMs: ${SUMMARY_TIMEOUT_MS}
`;

const ROLES = `version: 1
defaultRole: analyst
roles:
  - role: analyst
    description: Read-only. Answers a question about the code.
    systemPrompt: read and answer
    allowedTools: [fs.read]
    execution: cli
    tokenBudget: ${ROLE_BUDGET}
`;

/** The parts of the written bundle this test reads. The file is the in-toto statement. */
interface SummaryRecord {
  kind?:         string;
  role?:         string;
  nativeTools?:  string;
  model?:        string;
  lcmSummary?:   { level?: number; reportedTokens?: number; summaryId?: string };
}
interface BundlePredicate {
  outcome?:       { status?: string };
  lcmSettings?:   Record<string, unknown>;
  modelSurfaces?: SummaryRecord[];
}

/** Three kinds of call, told apart by what `run.ts` asked for. */
class RunAdapter implements CliAdapter {
  readonly name = 'round-two-recorder';
  readonly calls: { kind: 'plan' | 'summary' | 'task'; options: AdapterInvokeOptions }[] = [];
  private taskCount = 0;

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
      inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }

  isAvailable(): Promise<boolean> { return Promise.resolve(true); }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const summary = (options.systemPrompt ?? '').startsWith('You are a context summarization agent.');
    const plan = !summary && options.prompt.startsWith('Create a task execution DAG for:');
    this.calls.push({ kind: summary ? 'summary' : plan ? 'plan' : 'task', options });
    const output = summary ? SUMMARY_TEXT : plan ? PLAN : `answer ${++this.taskCount}`;
    return {
      success: true, output, exitCode: 0, duration: 1, toolCallLog: [],
      // No `modelSurface` on purpose: R6 says a summary is recorded even when the backend reports
      // none, and this run's bundle must show that record all the same.
      ...(summary ? { tokensUsed: REPORTED_TOKENS } : {}),
    };
  }

  async *stream(): AsyncGenerator<string> { yield ''; }
}

test('maf run itself: the LCM factory is wired, from the summary call to the bundle (R1)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-task-lcm-'));
  try {
    const repo = await createDemoFixture(root);
    const mafDir = path.join(repo, '.maf');
    // `createDemoFixture` makes `<root>/repo` but not its `.maf/`.
    await mkdir(mafDir, { recursive: true });
    await writeFile(path.join(mafDir, 'config.yaml'), CONFIG, 'utf8');
    await writeFile(path.join(mafDir, 'roles.yaml'), ROLES, 'utf8');

    const adapter = new RunAdapter();
    const stdout = collector();
    const stderr = collector();
    const opts: RunOptions = {
      adapter: adapter.name,
      dir: repo,
      worktree: false,
      policy: '.maf/policy.yaml',
      roles: '.maf/roles.yaml',
    };
    // A typed adapter and roles file; the policy flag is the commander default, so it means the
    // shipped policy; worktree was not typed.
    const given = (flag: GivenFlag): boolean => flag === 'adapter' || flag === 'roles';

    await runTask('run one', opts, {
      adapters: registryOf(adapter),
      given,
      io: { stdout, stderr, isTTY: false },
    });

    // K7/K1: the run wrote its bundle under `.maf/attestations`, named for the run.
    const attestations = await readdir(path.join(mafDir, 'attestations'));
    const bundles = attestations.filter((f) => f.endsWith('.bundle.json'));
    assert.equal(bundles.length, 1, 'the run was attested once');
    const runId = bundles[0]!.slice(0, -'.bundle.json'.length);
    const statement = JSON.parse(
      await readFile(path.join(mafDir, 'attestations', bundles[0]!), 'utf8'),
    ) as { predicate: BundlePredicate };
    const predicate = statement.predicate;
    assert.equal(predicate.outcome?.status, 'Succeeded', 'both nodes ran');

    const plans = adapter.calls.filter((c) => c.kind === 'plan');
    const tasks = adapter.calls.filter((c) => c.kind === 'task');
    const summaries = adapter.calls.filter((c) => c.kind === 'summary');
    assert.equal(plans.length, 1, 'the run planned through its adapter');
    assert.equal(tasks.length, 2, 'both planned nodes reached the backend');

    // K5: the settings in force — mode, operator, threshold, tail, timeout, model — are what
    // `maf run` read. A `run.ts` copy that built the engine from defaults, or forgot one field,
    // changes this record.
    assert.deepEqual(predicate.lcmSettings, {
      mode: 'Upward',
      operator: 'Agentic-Map',
      contextThreshold: 0.001,
      freshTailCount: 1,
      summaryTimeoutMs: SUMMARY_TIMEOUT_MS,
      model: 'run-model',
    });

    // K3/K4/K5/K2: one compaction was needed and it was made by the run's adapter, with the
    // configured model, text-only, with the configured timeout, where the run works.
    assert.equal(summaries.length, 1, 'one compaction was needed, and made');
    const summaryCall = summaries[0]!.options;
    assert.equal(summaryCall.model, 'run-model', 'the run\'s model is the summary call\'s model');
    assert.equal(summaryCall.nativeTools, false, 'a summary call asks for text only');
    assert.equal(summaryCall.timeoutMs, SUMMARY_TIMEOUT_MS, 'lcm.summaryTimeoutMs reaches the call');
    assert.equal(summaryCall.workingDir, repo, 'the summary runs in the run\'s working directory');
    assert.match(summaryCall.prompt, /\[USER\] \[analyst\] node one/, 'it summarizes node one');

    // K5: the operator is on the stored summary, and K6: the summary is reachable from this run's
    // archive only. Read it back by the id the record names — a second engine over the same
    // `.maf/lcm.db`, scoped to this run.
    const lcmRecords = (predicate.modelSurfaces ?? []).filter((r) => r.kind === 'lcm-summary');
    assert.equal(lcmRecords.length, 1, 'the summary call is in the same array as every role call');
    const record = lcmRecords[0]!;
    assert.equal(record.role, 'lcm');
    assert.equal(record.nativeTools, 'none');
    assert.equal(record.model, 'run-model');
    assert.equal(record.lcmSummary?.level, 0);
    assert.equal(record.lcmSummary?.reportedTokens, REPORTED_TOKENS);
    const summaryId = record.lcmSummary?.summaryId ?? '';

    const reopen = (sessionId: string): LcmEngine => new LcmEngine({
      dbPath: path.join(mafDir, 'lcm.db'),
      sessionId,
      contextThreshold: 0.75,
      freshTailCount: 64,
      mode: 'Upward',
      summarize: async () => 'unused',
    });
    const own = reopen(runId);
    const mine = await own.expandSummary(summaryId);
    own.close();
    assert.ok(mine, 'the run\'s own archive holds the summary it recorded');
    assert.equal(mine.summary.operator, 'Agentic-Map', 'lcm.operator reached the engine');

    const elsewhere = reopen('another-run');
    const theirs = await elsewhere.expandSummary(summaryId);
    elsewhere.close();
    assert.equal(theirs, undefined, 'another run cannot expand this run\'s summary');

    // K7: the summary reached the prompt of the node after it, and not the one before.
    assert.doesNotMatch(tasks[0]!.options.systemPrompt ?? '', new RegExp(SUMMARY_TEXT));
    assert.match(
      tasks[1]!.options.systemPrompt ?? '',
      new RegExp(`<summary [^>]*>[^<]*${SUMMARY_TEXT.replace(/\./g, '\\.')}`),
      'the second node is handed the summary node one produced',
    );
    assert.match(tasks[1]!.options.systemPrompt ?? '', /<summaries>/, 'the archive is rendered');

    // R5 through the user's path: the reported cost is charged to the triggering node, so the
    // node after it is given what remains of its budget.
    assert.equal(tasks[0]!.options.tokenBudget, ROLE_BUDGET);
    assert.equal(tasks[1]!.options.tokenBudget, ROLE_BUDGET - REPORTED_TOKENS,
      'the summary spent the triggering node\'s budget');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── V2: two runs, one `.maf/`, and the run's own expander ────────────────────────────────────

const RUN_B_CONFIG = CONFIG.replace('adapter: round-two-recorder', 'adapter: cross-run-probe');

const RUN_B_ROLES = `version: 1
defaultRole: probe
roles:
  - role: probe
    description: Read-only. Asks this run's archive for a summary it does not own.
    systemPrompt: probe the archive
    allowedTools: [fs.read, lcm.expand]
    execution: in-process
    tokenBudget: ${ROLE_BUDGET}
`;

const RUN_B_PLAN = [
  'Here is the plan.',
  '```json',
  JSON.stringify({
    nodes: [{ id: 'p1', label: 'probe the archive', description: 'probe the archive', agentRole: 'probe' }],
  }),
  '```',
].join('\n');

/**
 * Run B's model: an in-process reader that asks its own run's `lcm.expand` for run A's summary id.
 * The tool and the expander behind it are the ones `maf run` built for run B, so the assertion is
 * about `createRunLcm`'s `sessionId` and not about an engine the test opened itself.
 */
class CrossRunProbe implements TurnAdapter {
  readonly name = 'cross-run-probe';
  /** What the loop fed back for `lcm.expand`: the refusal, or — with the session dropped — the summary. */
  expansion: string | undefined;

  constructor(private readonly foreignSummaryId: string) {}

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
      inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }

  isAvailable(): Promise<boolean> { return Promise.resolve(true); }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    // The planner is a text-only call; a summary call can happen while this run assembles its own
    // archive, and must be answered as one rather than mistaken for a plan.
    const plan = options.prompt.startsWith('Create a task execution DAG for:');
    return {
      success: true, output: plan ? RUN_B_PLAN : 'run B summary text', exitCode: 0, duration: 1,
      toolCallLog: [],
    };
  }

  async *stream(): AsyncGenerator<string> { yield ''; }

  async sendTurn(history: TurnMessage[]): Promise<AssistantTurn> {
    const results = history.filter((message) => message.kind === 'tool');
    if (results.length === 0) {
      return {
        text: 'asking the archive',
        toolCalls: [
          { toolUseId: 'x1', toolName: 'lcm.expand', input: { summaryId: this.foreignSummaryId } },
          // A reader must make an executed call or D-46 fails the node with `no_work`. The expand
          // above is executed even when it refuses, but this read does not depend on that reading.
          { toolUseId: 'r1', toolName: 'fs.read', input: { path: 'sum.js' } },
        ],
      };
    }
    this.expansion = results.find((message) => message.toolName === 'lcm.expand')?.content;
    return { text: 'probe complete', toolCalls: [] };
  }
}

test('maf run: a second run in the same .maf cannot expand the first run\'s summary (V2)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-task-lcm-cross-'));
  try {
    const repo = await createDemoFixture(root);
    const mafDir = path.join(repo, '.maf');
    await mkdir(mafDir, { recursive: true });
    const configPath = path.join(mafDir, 'config.yaml');
    const rolesPath = path.join(mafDir, 'roles.yaml');
    await writeFile(configPath, CONFIG, 'utf8');
    await writeFile(rolesPath, ROLES, 'utf8');

    const opts: RunOptions = {
      adapter: 'round-two-recorder',
      dir: repo,
      worktree: false,
      policy: '.maf/policy.yaml',
      roles: '.maf/roles.yaml',
    };
    const given = (flag: GivenFlag): boolean => flag === 'adapter' || flag === 'roles';
    const io = { stdout: collector(), stderr: collector(), isTTY: false };
    const attestations = path.join(mafDir, 'attestations');

    // Run A: one node's message is compacted into a summary the bundle names.
    await runTask('run one', opts, { adapters: registryOf(new RunAdapter()), given, io });
    const afterA = (await readdir(attestations)).filter((f) => f.endsWith('.bundle.json'));
    assert.equal(afterA.length, 1, 'run A was attested once');
    const aStatement = JSON.parse(
      await readFile(path.join(attestations, afterA[0]!), 'utf8'),
    ) as { predicate: BundlePredicate };
    const summaryId = (aStatement.predicate.modelSurfaces ?? [])
      .find((record) => record.kind === 'lcm-summary')?.lcmSummary?.summaryId ?? '';
    assert.ok(summaryId, 'run A recorded the summary its archive holds');

    // Run B: the same repository, the same `.maf/lcm.db`, a different run id.
    await writeFile(configPath, RUN_B_CONFIG, 'utf8');
    await writeFile(rolesPath, RUN_B_ROLES, 'utf8');
    const probe = new CrossRunProbe(summaryId);
    await runTask('run two', { ...opts, adapter: probe.name }, {
      adapters: registryOf(probe), given, io,
    });

    const afterB = (await readdir(attestations)).filter((f) => f.endsWith('.bundle.json'));
    const bBundle = afterB.find((f) => !afterA.includes(f));
    assert.ok(bBundle, 'run B was attested');
    const bStatement = JSON.parse(
      await readFile(path.join(attestations, bBundle!), 'utf8'),
    ) as { predicate: BundlePredicate };
    assert.equal(bStatement.predicate.outcome?.status, 'Succeeded',
      'the probe read and expanded, so the reader did its work');

    const expansion = probe.expansion;
    assert.ok(expansion, 'run B\'s in-process reader was handed the lcm.expand result');
    assert.match(expansion, /an id from another run cannot be expanded here/,
      'run B\'s own expander refuses run A\'s summary id');
    assert.doesNotMatch(expansion, new RegExp(SUMMARY_TEXT.replace(/\./g, '\\.')),
      'and none of run A\'s summary text reaches run B');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
