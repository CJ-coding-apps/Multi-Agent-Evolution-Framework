import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, TurnAdapter, AdapterCapabilities, AdapterInvokeResult, AssistantTurn, DagNode,
  ReviewAttestation, SecurityReviewResult,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, GateRefused, ReviewRefused, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import { mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { ReviewGate } from '@maf/git-ops';
import type { ReviewDecision, ReviewRequest, SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';

// ORACLE: WP-2.3 — the human review gate runs for the roles the security gate runs for, after
// its verdict and never after a refusal, on the diff the gate read. Required: the writer node
// waits for the decision, and anything but an approval fails it with ReviewRefused. Advisory:
// the request and outcome are recorded and the node completes. Before this, the dispatcher
// declared `reviewGate` and never read it.

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

class CliOnlyAdapter implements CliAdapter {
  readonly name = 'cli-only';
  /** Stands in for whatever the CLI agent does to the tree while it runs. */
  onInvoke: (() => Promise<void>) | undefined;
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    await this.onInvoke?.();
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

/** An in-process backend whose one turn changes the tree, then finishes. */
class EditingTurnAdapter implements TurnAdapter {
  readonly name = 'turns';
  constructor(private readonly edit: () => Promise<void>) {}
  capabilities(): AdapterCapabilities { return { ...CAPS, inProcessLoop: true }; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    return { success: true, output: 'CLI-PATH', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
  async sendTurn(): Promise<AssistantTurn> {
    await this.edit();
    return { text: 'done', toolCalls: [] };
  }
}

const CODER = { name: 'coder', allowedTools: ['fs.read', 'fs.write', 'git.commit'] };
const READER = { name: 'analyst', allowedTools: ['fs.read', 'grep'] };

function nodeFor(role: string): DagNode {
  return {
    id: makeNodeId(`${role}-1`), label: 'do the work', agentRole: defineRoleName(role), dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'do the work' },
  };
}

/** Every gate event in order, so a test can say which gate ran first and how often. */
type GateEvent = 'security' | 'review';

interface Fixture {
  dispatcher: RoleDispatcher;
  events: GateEvent[];
  approvals: ReviewAttestation[];
  asked: ReviewRequest[];
}

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-review-'));
  await writeFile(path.join(dir, 'hello.txt'), 'hello', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

function makeFixture(opts: {
  workDir: string;
  /** What the reviewer answers; it is asked only when a gate is built. */
  answer?: (request: ReviewRequest) => Promise<ReviewDecision>;
  required?: boolean;
  timeoutMs?: number;
  /** No ReviewGate at all, as a run that wires none. */
  noReviewGate?: boolean;
  /** The security gate's verdict; `'none'` wires no security gate. */
  security?: 'pass' | 'refuse' | 'none';
  harness?: HarnessConfig;
  role?: { name: string; allowedTools: string[] };
  execution?: 'cli' | 'in-process';
  adapter?: CliAdapter;
}): Fixture {
  const events: GateEvent[] = [];
  const approvals: ReviewAttestation[] = [];
  const asked: ReviewRequest[] = [];
  const role = opts.role ?? CODER;
  const execution = opts.execution ?? 'cli';
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: defineRoleName(role.name),
    roles: [{
      role: defineRoleName(role.name), systemPrompt: 'work',
      allowedTools: role.allowedTools.map((id) => makeToolId(id)), execution,
    }],
  }, opts.workDir);

  const securityGate = {
    reviewDiff: async (): Promise<SecurityReviewResult> => {
      events.push('security');
      return opts.security === 'refuse'
        ? { findings: [{ severity: 'critical', category: 'cmdi', file: 'hello.txt', rationale: '', remediation: '' }], summary: 'refused', passed: false }
        : { findings: [], summary: 'clean', passed: true };
    },
  } as unknown as SecurityReviewGate;

  const answer = opts.answer ?? (async () => ({ verdict: 'Approve' as const, reviewer: 'alice' }));
  const reviewGate = new ReviewGate({
    reviewer: async (request) => { events.push('review'); asked.push(request); return answer(request); },
    ...(opts.required !== undefined ? { required: opts.required } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const dispatcher = new RoleDispatcher({
    adapter: opts.adapter ?? new CliOnlyAdapter(),
    baseTools: createDefaultRegistry() as ToolRegistry,
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: {
      record: async () => {},
      recordSecurityFindings: () => {},
      addApproval: (a: ReviewAttestation) => { approvals.push(a); },
    } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd: opts.workDir,
    sessionId: 's1',
    runId: makeRunId('run-review'),
    harness: opts.harness ?? mintHarnessConfig({
      id: 'test',
      roleSet: { version: 1, defaultRole: role.name, roles: [{ role: role.name, allowedTools: role.allowedTools, execution }] },
      processorBundles: [{ name: 'security-gate' }],
    }),
    ...(opts.security === 'none' ? {} : { securityGate }),
    ...(opts.noReviewGate ? {} : { reviewGate }),
  });
  return { dispatcher, events, approvals, asked };
}

/** A CLI agent that changes the tree, so there is a diff to review. */
function changingAgent(workDir: string, text = 'hello, changed'): CliOnlyAdapter {
  const adapter = new CliOnlyAdapter();
  adapter.onInvoke = async () => { await writeFile(path.join(workDir, 'hello.txt'), text, 'utf8'); };
  return adapter;
}

async function withRepo(fn: (workDir: string) => Promise<void>): Promise<void> {
  const workDir = await makeRepoDir();
  try { await fn(workDir); } finally { await rm(workDir, { recursive: true, force: true }); }
}

test('required: the writer node waits for the decision, and an approval lets it complete', async () => {
  await withRepo(async (workDir) => {
    let approve: ((d: ReviewDecision) => void) | undefined;
    const fx = makeFixture({
      workDir, required: true, adapter: changingAgent(workDir),
      answer: () => new Promise<ReviewDecision>((resolve) => { approve = resolve; }),
    });
    let settled = false;
    const running = fx.dispatcher.runNode(nodeFor('coder')).finally(() => { settled = true; });
    // Bounded, so a dispatcher that never asks fails here instead of hanging the suite.
    for (let waited = 0; !approve; waited += 5) {
      assert.ok(waited < 5_000, 'the reviewer was never asked');
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false, 'the node is held while the reviewer has not decided');

    approve?.({ verdict: 'Approve', reviewer: 'alice' });
    await running;
    assert.deepEqual(fx.events, ['security', 'review'], 'the review comes after the security verdict');
    assert.match(fx.asked[0]?.diff ?? '', /hello, changed/, 'on the diff the security gate read');
    assert.equal(fx.asked[0]?.required, true);
    assert.equal(fx.approvals.length, 1);
    assert.equal(fx.approvals[0]?.decision.status, 'Approved');
    assert.equal(fx.approvals[0]?.decision.reviewer, 'alice');
  });
});

test('required: a denial fails the node with ReviewRefused, attested before the throw', async () => {
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, required: true, adapter: changingAgent(workDir),
      answer: async () => ({ verdict: 'Deny', reviewer: 'bob', comment: 'not this way' }),
    });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof ReviewRefused, `expected ReviewRefused, got ${String(err)}`);
      assert.match(err.message, /bob denied it \(not this way\)/);
      assert.equal(err.requestId, fx.asked[0]?.id);
      return true;
    });
    assert.equal(fx.approvals.length, 1, 'the denial is in the attestation');
    assert.equal(fx.approvals[0]?.decision.status, 'Rejected');
  });
});

test('required: a reviewer that does not answer in time fails the node', async () => {
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, required: true, timeoutMs: 20, adapter: changingAgent(workDir),
      answer: () => new Promise<ReviewDecision>(() => {}),
    });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), ReviewRefused);
    assert.equal(fx.approvals[0]?.decision.status, 'TimedOut');
  });
});

test('advisory (the default): a denial is recorded with its request and the node completes', async () => {
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, adapter: changingAgent(workDir),
      answer: async () => ({ verdict: 'Deny', reviewer: 'bob' }),
    });
    const out = await fx.dispatcher.runNode(nodeFor('coder'));
    assert.deepEqual(out['output'], { kind: 'string', value: 'CLI-PATH' });
    assert.equal(fx.asked.length, 1);
    assert.equal(fx.asked[0]?.required, false);
    assert.equal(fx.approvals.length, 1);
    assert.equal(fx.approvals[0]?.requestId, fx.asked[0]?.id, 'the record names the request');
    assert.equal(fx.approvals[0]?.diffHash, fx.asked[0]?.diffHash);
    assert.equal(fx.approvals[0]?.decision.status, 'Rejected');
  });
});

test('a change the security gate refused is never sent for review', async () => {
  await withRepo(async (workDir) => {
    const fx = makeFixture({ workDir, required: true, security: 'refuse', adapter: changingAgent(workDir) });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(err instanceof GateRefused && !(err instanceof ReviewRefused), `the security verdict stands, got ${String(err)}`);
      return true;
    });
    assert.deepEqual(fx.events, ['security']);
    assert.deepEqual(fx.approvals, []);
  });
});

test('the review runs for the roles the security gate runs for: a reader and an unchanged tree are not asked', async () => {
  await withRepo(async (workDir) => {
    const reader = makeFixture({ workDir, required: true, role: READER, adapter: changingAgent(workDir) });
    await reader.dispatcher.runNode(nodeFor('analyst'));
    assert.deepEqual(reader.events, [], 'a role without a write tool is reviewed by neither gate');
  });
  await withRepo(async (workDir) => {
    const idle = makeFixture({ workDir, required: true });
    await idle.dispatcher.runNode(nodeFor('coder'));
    assert.deepEqual(idle.events, [], 'nothing changed, so there is nothing to review');
    assert.deepEqual(idle.approvals, []);
  });
});

test('a diff that cannot be read fails the node before any reviewer is asked', async () => {
  // The fall-open this replaces: `harvest(...).catch(() => '')` turned "could not look" into
  // "no changes", which the old gate approved. Advisory is the case where that would be silent.
  await withRepo(async (workDir) => {
    const adapter = new CliOnlyAdapter();
    adapter.onInvoke = async () => {
      await writeFile(path.join(workDir, 'hello.txt'), 'hello, changed', 'utf8');
      await rm(path.join(workDir, '.git'), { recursive: true, force: true });
    };
    const fx = makeFixture({ workDir, adapter });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
      assert.ok(!(err instanceof GateRefused), `a read failure is an error, not a verdict; got ${String(err)}`);
      return true;
    });
    assert.deepEqual(fx.asked, []);
    assert.deepEqual(fx.approvals, [], 'and nothing is recorded as reviewed');
  });
});

test('with no security gate wired, a required review still runs', async () => {
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, required: true, security: 'none', adapter: changingAgent(workDir),
      answer: async () => ({ verdict: 'Deny', reviewer: 'bob' }),
    });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), ReviewRefused);
    assert.deepEqual(fx.events, ['review']);
  });
});

test('a harness that requires review refuses a run wired with an advisory gate or none', async () => {
  const requiring = mintHarnessConfig({
    id: 'reviewed',
    roleSet: { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', allowedTools: CODER.allowedTools, execution: 'cli' }] },
    processorBundles: [],
    reviewGate: { required: true },
  });
  for (const wiring of [{ noReviewGate: true }, { required: false }]) {
    await withRepo(async (workDir) => {
      const fx = makeFixture({ workDir, harness: requiring, adapter: changingAgent(workDir), ...wiring });
      await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => {
        assert.ok(err instanceof ReviewRefused, `expected ReviewRefused, got ${String(err)}`);
        assert.match(err.message, /Harness "reviewed" requires a human review/);
        return true;
      });
      assert.deepEqual(fx.asked, [], 'nobody was asked, and no approval is claimed');
      assert.deepEqual(fx.approvals, []);
    });
  }
  await withRepo(async (workDir) => {
    const fx = makeFixture({ workDir, harness: requiring, required: true, adapter: changingAgent(workDir) });
    await fx.dispatcher.runNode(nodeFor('coder'));
    assert.equal(fx.approvals[0]?.decision.status, 'Approved', 'a required gate satisfies the harness');
  });
});

test('in-process tier: the review runs at task_end, and a denial is asked and attested once', async () => {
  // The refusal comes out of the loop's task_end. The dispatcher's catch reviews a throwing
  // backend's diff unless the error is already a verdict; ReviewRefused is one, so the human is
  // not asked a second time and the security gate does not run again.
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, required: true, execution: 'in-process',
      adapter: new EditingTurnAdapter(async () => { await writeFile(path.join(workDir, 'hello.txt'), 'changed in-process', 'utf8'); }),
      answer: async () => ({ verdict: 'Deny', reviewer: 'bob' }),
    });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), ReviewRefused);
    assert.deepEqual(fx.events, ['security', 'review']);
    assert.equal(fx.approvals.length, 1);
  });
});

test('a backend that throws after changing the tree: a denial outranks the failure, an approval lets it through', async () => {
  const dying = (workDir: string) => {
    const adapter = new CliOnlyAdapter();
    adapter.onInvoke = async () => {
      await writeFile(path.join(workDir, 'hello.txt'), 'changed, then the backend died', 'utf8');
      throw new TransportError('claude did not finish within 1000 ms and was killed (exit code 124).');
    };
    return adapter;
  };
  await withRepo(async (workDir) => {
    const fx = makeFixture({
      workDir, required: true, adapter: dying(workDir),
      answer: async () => ({ verdict: 'Deny', reviewer: 'bob' }),
    });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), ReviewRefused);
    assert.match(fx.asked[0]?.diff ?? '', /backend died/);
  });
  await withRepo(async (workDir) => {
    const fx = makeFixture({ workDir, required: true, adapter: dying(workDir) });
    await assert.rejects(fx.dispatcher.runNode(nodeFor('coder')), (err: unknown) => err instanceof TransportError);
    assert.equal(fx.approvals[0]?.decision.status, 'Approved', 'the approval is recorded; the transport failure is retried as before');
  });
});
