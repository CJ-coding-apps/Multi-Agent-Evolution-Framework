import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId, TransportError } from '@maf/types';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, CliAdapter,
} from '@maf/types';
import { mintHarnessConfig } from '@maf/harness-config';
import { buildRunStack } from '../wiring.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { DEFAULT_MAF_CONFIG } from '../config/ConfigLoader.js';
import type { ResolvedMafConfig } from '../config/ConfigLoader.js';
import { needsLcm } from './runFixture.js';

// ORACLE: WP-3.2 F3 (D-52) — the wiring from a command to the archive, proved through the stack
// goldens and evolve share. A run that crosses the threshold must make a summarization call with
// the configured model and no backend tools, and the summary it stores must be what the *next*
// node's system prompt carries. Each assertion kills a concrete way the wiring could regress:
//
//   W1 — the summary call does not use `lcm.model`
//   W2 — the summary call lets the backend use its own tools (`nativeTools` not false)
//   W3 — the summary is made but never reaches the prompt
//   W4 — the summary is made and charged to no record / no node budget
//
// W-labels are this file's own; they are deliberately not the verifier's mutant ids (round 2, R1).

const SUMMARY_TEXT = 'Node one read the sum module and chose the blue option.';
const REPORTED_TOKENS = 42;
const ROLE_BUDGET = 10_000;

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A backend that answers task calls and summarization calls differently, and keeps every request.
 * The summary is recognized by the system prompt the adapter summarizer sends; anything else is a
 * role call. A `Task` call's output is deterministic so the test can name node one's transcript.
 */
class RecordingAdapter implements CliAdapter {
  readonly name = 'cli-recorder';
  readonly calls: { kind: 'summary' | 'task'; options: AdapterInvokeOptions }[] = [];
  private taskCount = 0;

  /**
   * A backend whose summarization calls fail, for F5. `transport` is the retryable class
   * (`TransportError`); `error` is a judgement, which must not be retried.
   */
  constructor(private readonly failSummary?: 'transport' | 'error') {}

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
      inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }

  isAvailable(): Promise<boolean> { return Promise.resolve(true); }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const summary = (options.systemPrompt ?? '').startsWith('You are a context summarization agent.');
    this.calls.push({ kind: summary ? 'summary' : 'task', options });
    if (summary && this.failSummary) {
      return {
        success: false, output: '', exitCode: 1, duration: 1, toolCallLog: [],
        ...(this.failSummary === 'transport'
          ? { transportError: new TransportError('backend timed out after 120000ms') }
          : {}),
      };
    }
    const output = summary ? SUMMARY_TEXT : `answer ${++this.taskCount}`;
    return {
      success: true, output, exitCode: 0, duration: 1, toolCallLog: [],
      ...(summary ? { tokensUsed: REPORTED_TOKENS } : {}),
      modelSurface: {
        systemPromptSha256: sha256(options.systemPrompt ?? ''),
        toolCatalog: '',
        argv: [],
        promptSha256: sha256(options.prompt),
        outputSha256: sha256(output),
      },
    };
  }

  // Not used by a cli-tier reader with `inProcessLoop: false`; present to satisfy the interface.
  async *stream(): AsyncGenerator<string> { yield ''; }
}

/**
 * The same stack over a fresh repository and archive, with the `lcm` settings under test. Shared by
 * the operator and off-mode tests, which differ only in what this object says.
 */
async function withWiringStack(
  lcm: Partial<ReturnType<typeof settings>>,
  run: (stack: Awaited<ReturnType<typeof buildRunStack>>, adapter: RecordingAdapter, harness: ReturnType<typeof mintHarnessConfig>, runId: ReturnType<typeof makeRunId>, repo: string, mafDir: string) => Promise<void>,
  adapter = new RecordingAdapter(),
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-lcm-wiring-'));
  try {
    const repo = await createDemoFixture(root);
    const mafDir = path.join(root, 'state');
    await mkdir(mafDir, { recursive: true });
    const harness = mintHarnessConfig({
      id: 'lcm-wiring', processorBundles: [],
      roleSet: {
        version: 1, defaultRole: 'analyst',
        roles: [{
          role: 'analyst', systemPrompt: 'read and answer', allowedTools: ['fs.read'],
          execution: 'cli', tokenBudget: ROLE_BUDGET,
        }],
      },
    });
    const runId = makeRunId(crypto.randomUUID());
    const stack = await buildRunStack({
      cwd: repo, mafDir, policy: { value: 'policy.yaml', typed: false }, adapter, runId,
      harnessSha: harness.sha, lcm: { ...settings(), ...lcm },
    });
    try {
      await run(stack, adapter, harness, runId, repo, mafDir);
    } finally {
      stack.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function settings(): ResolvedMafConfig['lcm'] {
  return {
    ...DEFAULT_MAF_CONFIG.lcm, mode: 'Upward' as const, contextThreshold: 0.001, freshTailCount: 1,
    model: 'summary-model', summaryTimeoutMs: 4_321,
  };
}

test('run wiring: a summary made with the configured model reaches the next node (F3)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-lcm-wiring-'));
  try {
    const repo = await createDemoFixture(root);
    const mafDir = path.join(root, 'state');
    await mkdir(mafDir, { recursive: true });

    // A reader: it holds no write tool, so it runs on the cli tier without --allow-ungoverned and
    // every adapter call is the test's to see. `tokenBudget` is present so the summary's charge can
    // be observed on the next call.
    const harness = mintHarnessConfig({
      id: 'lcm-wiring', processorBundles: [],
      roleSet: {
        version: 1, defaultRole: 'analyst',
        roles: [{
          role: 'analyst', systemPrompt: 'read and answer', allowedTools: ['fs.read'],
          execution: 'cli', tokenBudget: ROLE_BUDGET,
        }],
      },
    });

    const adapter = new RecordingAdapter();
    const runId = makeRunId(crypto.randomUUID());
    const stack = await buildRunStack({
      cwd: repo, mafDir, policy: { value: 'policy.yaml', typed: false }, adapter, runId,
      harnessSha: harness.sha,
      // The threshold is crossed by the first node's transcript lines, not by a model's output.
      // `freshTailCount: 1` keeps the current node's own user line raw.
      lcm: { ...settings() },
    });
    try {
      await stack.dispatchTask(harness, 'analyst', 'node one', repo, 60_000, 0);
      await stack.dispatchTask(harness, 'analyst', 'node two', repo, 60_000, 0);
      const bundle = await stack.attestor.bundle(
        { id: 'test', modelVersion: 'cli-recorder' },
        { configSource: { uri: 'test', digest: { sha256: harness.sha } }, parameters: {}, environment: {} },
        [], { status: 'Succeeded', unscheduled: [] },
      );

      const taskCalls = adapter.calls.filter((call) => call.kind === 'task');
      const summaryCalls = adapter.calls.filter((call) => call.kind === 'summary');
      assert.equal(taskCalls.length, 2, 'both nodes reached the backend');

      // W1/W2: the summary is a model call like any other, with the operator's model and no tools.
      assert.equal(summaryCalls.length, 1, 'one compaction was needed, and made');
      const summaryCall = summaryCalls[0]!.options;
      assert.equal(summaryCall.model, 'summary-model', 'lcm.model is the summary call\'s model');
      assert.equal(summaryCall.nativeTools, false, 'a summary call asks for text only');
      // R8: every `lcm` setting reaches the engine. The timeout is the one a slow backend depends
      // on, and a default here would silently outrank the run's config.
      assert.equal(summaryCall.timeoutMs, 4_321, 'lcm.summaryTimeoutMs reaches the call');
      assert.match(summaryCall.prompt, /\[USER\] \[analyst\] node one/, 'it summarizes node one\'s history');
      assert.ok(summaryCall.prompt.length <= 64 * 1024, 'the prompt is under the single-argument cap');

      // W3: the summary is in the prompt of the node after it, and not in the one before.
      assert.doesNotMatch(taskCalls[0]!.options.systemPrompt ?? '', new RegExp(SUMMARY_TEXT));
      assert.match(
        taskCalls[1]!.options.systemPrompt ?? '',
        new RegExp(`<summary [^>]*>[^<]*${SUMMARY_TEXT.replace(/\./g, '\\.')}`),
        'the second node is handed the summary node one produced',
      );

      // W4: the call is in the run's record, attributed to the node whose assembly made it.
      const lcmRecords = (bundle.modelSurfaces ?? []).filter((record) => record.kind === 'lcm-summary');
      assert.equal(lcmRecords.length, 1, 'the summary call is in the same array as every role call');
      const record = lcmRecords[0]!;
      assert.equal(record.role, 'lcm');
      assert.equal(record.nativeTools, 'none');
      assert.equal(record.model, 'summary-model');
      assert.equal(record.lcmSummary?.level, 0);
      assert.equal(record.lcmSummary?.reportedTokens, REPORTED_TOKENS);
      assert.ok(record.lcmSummary?.messages >= 2, 'it names the messages it covered');

      // F1: the call's reported tokens are charged to the node that triggered it. Node two's
      // budget is what remains; node one's, before the call, was untouched.
      assert.equal(taskCalls[0]!.options.tokenBudget, ROLE_BUDGET);
      assert.equal(taskCalls[1]!.options.tokenBudget, ROLE_BUDGET - REPORTED_TOKENS,
        'the summary spent the triggering node\'s budget');
    } finally {
      stack.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run wiring: lcm.operator agentic-map compacts through the sub-agent (F3)', needsLcm, async () => {
  await withWiringStack({ operator: 'agentic-map' }, async (stack, adapter, harness, runId, repo) => {
    await stack.dispatchTask(harness, 'analyst', 'node one', repo, 60_000, 0);
    await stack.dispatchTask(harness, 'analyst', 'node two', repo, 60_000, 0);

    const summaryCalls = adapter.calls.filter((call) => call.kind === 'summary');
    assert.equal(summaryCalls.length, 1, 'the operator named in config made the call');
    assert.equal(summaryCalls[0]!.options.nativeTools, false);

    // The operator is in the stored summary, not only in the engine's default: the setting reached
    // the engine through the stack (F12). Read it back by the id the record names, not through
    // `assembleContext`: that call would compact node two's newly appended history and add a
    // second root, which is the engine working, not the setting arriving.
    const bundle = await stack.attestor.bundle(
      { id: 'test', modelVersion: 'cli-recorder' },
      { configSource: { uri: 'test', digest: { sha256: harness.sha } }, parameters: {}, environment: {} },
      [], { status: 'Succeeded', unscheduled: [] },
    );
    const record = (bundle.modelSurfaces ?? []).find((r) => r.kind === 'lcm-summary');
    assert.ok(record?.lcmSummary?.summaryId, 'the summary call is recorded with its summary id');
    const expanded = await stack.lcm.expandSummary(record.lcmSummary.summaryId!);
    assert.ok(expanded, 'the stored summary is reachable by the recorded id');
    assert.equal(expanded.summary.operator, 'Agentic-Map', 'lcm.operator reached the engine');
    assert.match(expanded.summary.content, new RegExp(SUMMARY_TEXT.replace(/\./g, '\\.')));
  });
});

test('run wiring: lcm.mode off compacts nothing and records nothing (F14)', needsLcm, async () => {
  await withWiringStack({ mode: 'off' }, async (stack, adapter, harness, runId, repo) => {
    await stack.dispatchTask(harness, 'analyst', 'node one', repo, 60_000, 0);
    await stack.dispatchTask(harness, 'analyst', 'node two', repo, 60_000, 0);

    assert.equal(adapter.calls.filter((call) => call.kind === 'summary').length, 0,
      'off means no compaction call');
    const ctx = await stack.lcm.assembleContext(runId, 4096, 'off');
    assert.deepEqual(ctx.summaries ?? [], [], 'off stores no summaries to render');
    assert.deepEqual(ctx.ghosts, [], 'off stores no cues either');
  });
});

test('a failing summarizer degrades the compaction, not the node (F5)', needsLcm, async () => {
  // F5: losing the compressor must not lose the run. The node still runs and succeeds, the
  // failure is written where an operator will see it, and the bundle carries why. A transport
  // failure is retried once (D-06) before the assembly gives up.
  const adapter = new RecordingAdapter('transport');
  await withWiringStack({}, async (stack, adapterUnderTest, harness, runId, repo, mafDir) => {
    await stack.dispatchTask(harness, 'analyst', 'node one', repo, 60_000, 0);
    await stack.dispatchTask(harness, 'analyst', 'node two', repo, 60_000, 0);

    assert.equal(adapterUnderTest.calls.filter((call) => call.kind === 'task').length, 2,
      'both nodes still ran');
    assert.equal(adapterUnderTest.calls.filter((call) => call.kind === 'summary').length, 2,
      'the transport failure was retried once, then the assembly continued');

    const bundle = await stack.attestor.bundle(
      { id: 'test', modelVersion: 'cli-recorder' },
      { configSource: { uri: 'test', digest: { sha256: harness.sha } }, parameters: {}, environment: {} },
      [], { status: 'Succeeded', unscheduled: [] },
    );
    assert.equal(bundle.lcmDegraded?.length, 1, 'the degradation is in the run\'s record');
    assert.match(bundle.lcmDegraded![0]!.reason, /timed out/);

    const transcript = await readFile(path.join(mafDir, 'transcripts', `${runId}.jsonl`), 'utf8');
    assert.match(transcript,
      /\[lcm\] compaction failed: .*timed out.*; continuing uncompacted/,
      'the operator can see the archive is behind');
  }, adapter);
});

test('a summarizer that answers with a failure is not retried (F5)', needsLcm, async () => {
  // Only `TransportError` is retried (D-06). A backend that answered "no" said something about the
  // request, and asking again would just spend the same budget twice.
  const adapter = new RecordingAdapter('error');
  await withWiringStack({}, async (stack, adapterUnderTest, harness, runId, repo) => {
    await stack.dispatchTask(harness, 'analyst', 'node one', repo, 60_000, 0);
    await stack.dispatchTask(harness, 'analyst', 'node two', repo, 60_000, 0);
    assert.equal(adapterUnderTest.calls.filter((call) => call.kind === 'summary').length, 1);
    assert.equal(adapterUnderTest.calls.filter((call) => call.kind === 'task').length, 2);
  }, adapter);
});
