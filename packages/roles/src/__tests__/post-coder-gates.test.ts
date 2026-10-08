import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, AdapterCapabilities, AdapterInvokeResult, DagNode, SecurityReviewResult,
} from '@maf/types';
import { makeNodeId, makeRunId, makeToolId, GateRefused, TransportError } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { Attestor } from '@maf/attestation';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { SecurityReviewGate } from '@maf/git-ops';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';

// ORACLE: A4 — the post-coder security gate reads the
// working-tree diff. A missing repository is an ERROR, not an empty diff: the silent `return`
// it replaces made "the coder changed nothing" and "we could not look" the same verdict, so
// a run that was never reviewed attested as reviewed.

const execFileAsync = promisify(execFile);

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

class CliOnlyAdapter implements CliAdapter {
  readonly name = 'cli-only';
  /** Stands in for whatever the CLI agent does to the tree while it runs. */
  onInvoke: (() => Promise<void>) | undefined;
  /** What the call returns; a reviewing adapter returns the review JSON here. */
  output = 'CLI-PATH';
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(): Promise<AdapterInvokeResult> {
    await this.onInvoke?.();
    return { success: true, output: this.output, toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

const CODER_NODE: DagNode = {
  id: makeNodeId('c1'), label: 'implement the change', agentRole: defineRoleName('coder'), dependencies: [],
  retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
  timeoutMs: 30_000, inputs: {}, outputs: {},
  metadata: { taskDescription: 'implement the change' },
};

interface Fixture {
  dispatcher: RoleDispatcher;
  reviews: string[];
  cleanup: () => Promise<void>;
}

/** The role under test. The gate keys on the tools a role holds, so the list is the point. */
interface RoleUnderTest {
  name: string;
  allowedTools: string[];
}

const CODER: RoleUnderTest = { name: 'coder', allowedTools: ['fs.read', 'fs.write', 'git.commit'] };

function nodeFor(role: string): DagNode {
  return { ...CODER_NODE, id: makeNodeId(`${role}-1`), agentRole: defineRoleName(role) };
}

async function makeFixture(opts: {
  workDir: string;
  securityGate?: SecurityReviewGate;
  /** What the CLI agent does to the working tree while it runs. */
  onInvoke?: () => Promise<void>;
  role?: RoleUnderTest;
}): Promise<Fixture> {
  const reviews: string[] = [];
  const role = opts.role ?? CODER;
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: defineRoleName(role.name),
    roles: [{
      role: defineRoleName(role.name), systemPrompt: 'work',
      allowedTools: role.allowedTools.map((id) => makeToolId(id)), execution: 'cli',
    }],
  }, opts.workDir);
  const adapter = new CliOnlyAdapter();
  if (opts.onInvoke) adapter.onInvoke = opts.onInvoke;

  const config = {
    adapter,
    baseTools: createDefaultRegistry() as ToolRegistry,
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: { evaluate: async () => ({ verdict: 'Allow' }) } as unknown as PolicyEngine,
    attestor: {
      record: async () => {},
      recordSecurityFindings: (_nodeId: string, r: SecurityReviewResult) => { reviews.push(r.summary); },
    } as unknown as Attestor,
    graph: { addNode: async () => 'n' } as unknown as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd: opts.workDir,
    sessionId: 's1',
    runId: makeRunId('run-gates'),
    harness: { processorBundles: [] } as unknown as HarnessConfig,
    ...(opts.securityGate ? { securityGate: opts.securityGate } : {}),
  };

  return {
    dispatcher: new RoleDispatcher(config),
    reviews,
    cleanup: () => rm(opts.workDir, { recursive: true, force: true }),
  };
}

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-gates-'));
  await writeFile(path.join(dir, 'hello.txt'), 'hello', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

test('no repository in the working dir: the gate errors instead of reporting a clean diff', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-gates-bare-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  const fx = await makeFixture({ workDir });
  try {
    // Both halves matter: that it refused, and that it says what to do about it.
    await assert.rejects(
      () => fx.dispatcher.runNode(CODER_NODE),
      /cannot review the coder diff — no usable git repository[\s\S]*run "git init" in/,
    );
    assert.deepEqual(fx.reviews, [], 'no review happened, and none is claimed');
  } finally {
    await fx.cleanup();
  }
});

test('a coder that commits its own work is still reviewed', async () => {
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    // Claude Code commonly commits what it changes. Diffing against HEAD would then see
    // nothing at all — the same fail-open, reached by a different route.
    onInvoke: async () => {
      await writeFile(path.join(workDir, 'hello.txt'), 'hello, changed', 'utf8');
      await execFileAsync('git', ['add', '-A'], { cwd: workDir });
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agent committed'], { cwd: workDir });
    },
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await fx.dispatcher.runNode(CODER_NODE);
    assert.equal(seen.length, 1, 'the gate must still be reached after the agent commits');
    assert.match(seen[0] ?? '', /changed/, 'and it must see what the agent committed');
  } finally {
    await fx.cleanup();
  }
});

test('a repository with no commits yet is reviewable, not an error', async () => {
  // `git init` and nothing else is what the error message tells the user to run, so it
  // must not lead straight back to the same error.
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-gates-unborn-'));
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  await execFileAsync('git', ['add', 'hello.txt'], { cwd: workDir });

  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { await writeFile(path.join(workDir, 'hello.txt'), 'hello, changed', 'utf8'); },
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await fx.dispatcher.runNode(CODER_NODE);
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /changed/);
  } finally {
    await fx.cleanup();
  }
});

test('a new file the coder never stages is reviewed', async () => {
  // The untracked gap: after a bare `git init` a coder that creates a file and leaves it
  // unstaged is invisible to `git diff <base>` — an empty diff, so every security finding in
  // that file went unreported. The diff must come from the throwaway staged snapshot.
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-gates-untracked-'));
  await execFileAsync('git', ['init', '-q'], { cwd: workDir });
  await writeFile(path.join(workDir, 'base.txt'), 'base', 'utf8');
  await execFileAsync('git', ['add', 'base.txt'], { cwd: workDir });

  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { await writeFile(path.join(workDir, 'secret.txt'), 'AWS_SECRET_ACCESS_KEY=abc', 'utf8'); },
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await fx.dispatcher.runNode(CODER_NODE);
    assert.equal(seen.length, 1, 'the gate must be reached for an unstaged new file');
    assert.match(seen[0] ?? '', /secret\.txt/, 'and it must see the file the coder left untracked');
  } finally {
    await fx.cleanup();
  }
});

test('an unchanged working tree is a no-op, not an error, and not a review', async () => {
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await fx.dispatcher.runNode(CODER_NODE);
    assert.deepEqual(seen, [], 'nothing changed ⇒ nothing to review, and that is not a failure');
  } finally {
    await fx.cleanup();
  }
});

test('a real change reaches the gate — the silence above is not vacuous', async () => {
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [], summary: 'clean', passed: true };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await writeFile(path.join(workDir, 'hello.txt'), 'hello, changed', 'utf8');
    await fx.dispatcher.runNode(CODER_NODE);
    assert.equal(seen.length, 1, 'the gate is actually reached on the CLI coder path');
    assert.match(seen[0] ?? '', /changed/);
    assert.deepEqual(fx.reviews, ['clean']);
  } finally {
    await fx.cleanup();
  }
});

// ORACLE: D-07 — the gate applies to every role that holds a write tool, not to the role name
// 'coder'. The default tester holds `patch.apply`; before this, its changes were never reviewed.

/** A gate double that records every diff it is handed and passes it. */
function recordingGate(seen: string[]): SecurityReviewGate {
  return {
    reviewDiff: async (diff: string) => {
      seen.push(diff);
      return { findings: [], summary: 'clean', passed: true };
    },
  } as unknown as SecurityReviewGate;
}

test('a tester that holds fs.write is reviewed like a coder', async () => {
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    role: { name: 'tester', allowedTools: ['fs.read', 'fs.write', 'test.run'] },
    onInvoke: async () => { await writeFile(path.join(workDir, 'hello.test.txt'), 'expect(hello)', 'utf8'); },
    securityGate: recordingGate(seen),
  });
  try {
    await fx.dispatcher.runNode(nodeFor('tester'));
    assert.equal(seen.length, 1, 'a tester holding a write tool must reach the gate');
    assert.match(seen[0] ?? '', /hello\.test\.txt/);
    assert.deepEqual(fx.reviews, ['clean'], 'and the review is attested');
  } finally {
    await fx.cleanup();
  }
});

test('a custom role holding only git.commit has its start commit captured and is reviewed', async () => {
  // The start commit is the half that matters here: a role that commits its own work diffs
  // clean against HEAD, so without the capture the gate would see nothing.
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    role: { name: 'release-bot', allowedTools: ['git.commit'] },
    onInvoke: async () => {
      await writeFile(path.join(workDir, 'hello.txt'), 'hello, released', 'utf8');
      await execFileAsync('git', ['add', '-A'], { cwd: workDir });
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bot committed'], { cwd: workDir });
    },
    securityGate: recordingGate(seen),
  });
  try {
    await fx.dispatcher.runNode(nodeFor('release-bot'));
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /released/);
  } finally {
    await fx.cleanup();
  }
});

test('a role with no write tool is not gated, and needs no repository', async () => {
  // The other direction: the predicate is "holds a write tool", not "every role". A reader in
  // a directory with no repository must not hit the start-commit capture at all.
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-gates-reader-'));
  await writeFile(path.join(workDir, 'hello.txt'), 'hello', 'utf8');
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    role: { name: 'reviewer', allowedTools: ['fs.read', 'grep', 'git.diff', 'git.log'] },
    securityGate: recordingGate(seen),
  });
  try {
    await fx.dispatcher.runNode(nodeFor('reviewer'));
    assert.deepEqual(seen, []);
    assert.deepEqual(fx.reviews, []);
  } finally {
    await fx.cleanup();
  }
});

test('blocking findings fail the node with GateRefused carrying the findings', async () => {
  const workDir = await makeRepoDir();
  const finding = {
    severity: 'critical' as const, category: 'cmdi', file: 'hello.txt',
    rationale: 'exec on input', remediation: 'execFile',
  };
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { await writeFile(path.join(workDir, 'hello.txt'), 'exec(input)', 'utf8'); },
    securityGate: {
      reviewDiff: async () => ({ findings: [finding], summary: 'one critical', passed: false }),
    } as unknown as SecurityReviewGate,
  });
  try {
    await assert.rejects(
      () => fx.dispatcher.runNode(CODER_NODE),
      (err: unknown) => {
        if (!(err instanceof GateRefused)) assert.fail(`expected GateRefused, got ${String(err)}`);
        assert.match(err.message, /1 blocking \(critical or high\) finding\(s\)\. one critical/);
        assert.deepEqual(err.findings, [finding]);
        return true;
      },
    );
    assert.deepEqual(fx.reviews, ['one critical'], 'the refusal is attested before the node fails');
  } finally {
    await fx.cleanup();
  }
});

test('a real gate blocks a critical finding even when the reviewer says passed: true', async () => {
  const workDir = await makeRepoDir();
  const reviewer = new CliOnlyAdapter();
  reviewer.output = JSON.stringify({
    findings: [{ severity: 'critical', category: 'cmdi', file: 'hello.txt', rationale: '', remediation: '' }],
    summary: 'critical, but passing it',
    passed: true,
  });
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { await writeFile(path.join(workDir, 'hello.txt'), 'exec(input)', 'utf8'); },
    securityGate: new SecurityReviewGate({ adapter: reviewer, projectRoot: workDir, securityPrompt: 'audit' }),
  });
  try {
    await assert.rejects(() => fx.dispatcher.runNode(CODER_NODE), GateRefused);
  } finally {
    await fx.cleanup();
  }
});

test('a diff over the cap fails the node with GateRefused, attested, and is never sent for review', async () => {
  const workDir = await makeRepoDir();
  let reviewCalls = 0;
  const reviewer = new CliOnlyAdapter();
  reviewer.onInvoke = async () => { reviewCalls++; };
  reviewer.output = JSON.stringify({ findings: [], summary: 'clean', passed: true });
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { await writeFile(path.join(workDir, 'hello.txt'), 'hello, changed', 'utf8'); },
    // Any real diff (headers alone) is longer than 10 characters.
    securityGate: new SecurityReviewGate({
      adapter: reviewer, projectRoot: workDir, securityPrompt: 'audit', maxDiffChars: 10,
    }),
  });
  try {
    await assert.rejects(
      () => fx.dispatcher.runNode(CODER_NODE),
      (err: unknown) => {
        if (!(err instanceof GateRefused)) assert.fail(`expected GateRefused, got ${String(err)}`);
        assert.match(err.message, /refuses a \d+-character diff: its review cap is 10 characters/);
        return true;
      },
    );
    assert.equal(reviewCalls, 0, 'the reviewer must never see an oversized diff, whole or sliced');
    assert.equal(fx.reviews.length, 1, 'the refusal is attested');
    assert.match(fx.reviews[0] ?? '', /review cap is 10 characters/);
  } finally {
    await fx.cleanup();
  }
});

test('a backend that throws after changing the tree is still reviewed, and a refusal outranks the failure', async () => {
  // A timed-out turn, a backend that died mid-run: the adapter throws, and on the in-process
  // tier the gate at task_end is never reached. The dispatcher reviews the diff before the
  // failure propagates, so a change left behind by a dying agent is never unreviewed.
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => {
      await writeFile(path.join(workDir, 'hello.txt'), 'changed, then the backend died', 'utf8');
      throw new TransportError('claude did not finish within 1000 ms and was killed (exit code 124).');
    },
    securityGate: {
      reviewDiff: async (diff: string) => {
        seen.push(diff);
        return { findings: [{ severity: 'critical', category: 'secrets', file: 'hello.txt', description: 'planted' }], summary: 'blocked', passed: false };
      },
    } as unknown as SecurityReviewGate,
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(CODER_NODE), (err: unknown) => {
      assert.ok(err instanceof GateRefused, `the verdict outranks the transport failure, got ${String(err)}`);
      return true;
    });
    assert.equal(seen.length, 1, 'the diff was reviewed although the backend threw');
    assert.match(seen[0] ?? '', /backend died/);
  } finally {
    await fx.cleanup();
  }
});

test('a backend that throws without changing the tree lets the transport failure through', async () => {
  const workDir = await makeRepoDir();
  const seen: string[] = [];
  const fx = await makeFixture({
    workDir,
    onInvoke: async () => { throw new TransportError('claude exited with code 1 without writing any output.'); },
    securityGate: {
      reviewDiff: async (diff: string) => { seen.push(diff); return { findings: [], summary: 'clean', passed: true }; },
    } as unknown as SecurityReviewGate,
  });
  try {
    await assert.rejects(fx.dispatcher.runNode(CODER_NODE), (err: unknown) => err instanceof TransportError);
    assert.equal(seen.length, 0, 'an empty diff is not sent for review');
  } finally {
    await fx.cleanup();
  }
});
