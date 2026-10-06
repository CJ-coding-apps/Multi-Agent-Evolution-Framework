import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ToolPlugin, ToolId, ToolContext, ToolResult, ToolCallRecord,
  PolicyEngineHandle, PolicyDecision, AttestorHandle, PolicyRule,
} from '@maf/types';
import { makeToolId, makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyEngine } from '@maf/policy-engine';
import { PatchApplyTool, GrepTool, GitAddTool, GitStatusTool, FsWriteTool } from '@maf/tools';
import { executeToolGated } from '../index.js';

// ORACLE: DEFECT_SWEEP_2026-09-25.md D-05 + docs/POLICY.md's documented path-rule guarantee.

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };

/**
 * The shipped rule, verbatim from the sweep: the very rule that was bypassed for `patch.apply`
 * because the tool derived its paths inside `execute`, after the gate had already closed.
 */
const PROTECT_SECRETS: PolicyRule = {
  id: 'protect-secrets',
  description: '',
  priority: 100,
  predicate: {
    toolId: [makeToolId('fs.write'), makeToolId('fs.delete'), makeToolId('patch.apply')],
    pathGlob: '**/.env*',
  },
  action: { kind: 'Deny', reason: 'secrets are off-limits' },
};

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

const ctxIn = (cwd: string, attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd,
  projectRoot: cwd,
  runId: makeRunId('r1'),
  taskId: makeTaskId('t1'),
  agentId: makeAgentId('a1'),
  sessionId: 's1',
  policy,
  attestor,
});

/** A one-file patch that turns `file` from `before` into `before` + `added`. */
function patchFor(file: string, before: string, added: string): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1,2 @@',
    ` ${before}`,
    `+${added}`,
    '',
  ].join('\n');
}

/** Run `body` in a scratch dir that already contains the named files. */
async function inScratch(files: Record<string, string>, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-declared-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents, 'utf8');
    }
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('D-05: patch.apply writing .env is DENIED, and the file is untouched', async () => {
  await inScratch({ '.env': 'SAFE=1\n' }, async (dir) => {
    const engine = new PolicyEngine({} as never);
    engine.loadRules([PROTECT_SECRETS]);
    const attestor = new SpyAttestor();
    const ctx = ctxIn(dir, attestor, engine);

    const patch = patchFor('.env', 'SAFE=1', 'API_KEY=ATTACKER-CONTROLLED');

    await assert.rejects(
      () => executeToolGated(new PatchApplyTool(), { diff: patch }, ctx, { policy: engine, attestor }),
      /Policy violation: Deny/,
      'the protect-secrets rule sees the path the patch will write',
    );

    assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), 'SAFE=1\n',
      'the guarded path never reaches the filesystem');
    assert.equal(attestor.records.length, 0, 'nothing is attested as having run');
  });
});

test('D-05 control: the same shape of patch, to a non-secret file, still runs', async () => {
  // Without this the test above would pass on a maf that denied everything.
  await inScratch({ 'notes.txt': 'SAFE=1\n' }, async (dir) => {
    const engine = new PolicyEngine({} as never);
    engine.loadRules([PROTECT_SECRETS]);
    const attestor = new SpyAttestor();
    const ctx = ctxIn(dir, attestor, engine);

    const patch = patchFor('notes.txt', 'SAFE=1', 'API_KEY=ATTACKER-CONTROLLED');
    await executeToolGated(new PatchApplyTool(), { diff: patch }, ctx, { policy: engine, attestor });

    assert.equal(await readFile(path.join(dir, 'notes.txt'), 'utf8'), 'SAFE=1\nAPI_KEY=ATTACKER-CONTROLLED\n',
      'a non-secret path is applied, so the deny above was the rule and not the tool');
  });
});

test('a path rule reaches grep, which had no path surface at all before', async () => {
  await inScratch({ '.env': 'SAFE=1\n', 'keep.txt': 'SAFE=1\n' }, async (dir) => {
    const engine = new PolicyEngine({} as never);
    engine.loadRules([{
      id: 'secrets-unreadable',
      description: '',
      priority: 100,
      predicate: { toolId: [makeToolId('grep')], pathGlob: '**/.env*' },
      action: { kind: 'Deny', reason: 'no reading secrets either' },
    }]);
    const attestor = new SpyAttestor();
    const ctx = ctxIn(dir, attestor, engine);
    const grep = new GrepTool();

    assert.deepEqual(grep.declaredPaths({ pattern: 'SAFE', path: '.env' }), ['.env']);

    await assert.rejects(
      () => executeToolGated(grep, { pattern: 'SAFE', path: '.env' }, ctx, { policy: engine, attestor }),
      /Policy violation: Deny/,
    );

    // The same call against a non-secret path is allowed through to execution.
    const ok = await executeToolGated(
      grep, { pattern: 'SAFE', path: 'keep.txt' }, ctx, { policy: engine, attestor },
    );
    assert.equal(ok.exitCode, 0);
  });
});

test('a path rule reaches git.add, whose named paths were invisible to policy', async () => {
  await inScratch({}, async (dir) => {
    const engine = new PolicyEngine({} as never);
    engine.loadRules([{
      id: 'no-staging-secrets',
      description: '',
      priority: 100,
      predicate: { toolId: [makeToolId('git.add')], pathGlob: '**/.env*' },
      action: { kind: 'Deny', reason: 'never stage secrets' },
    }]);
    const attestor = new SpyAttestor();
    const ctx = ctxIn(dir, attestor, engine);
    const add = new GitAddTool();

    assert.deepEqual(add.declaredPaths({ paths: ['src/a.ts', '.env'] }).sort(), ['.env', 'src/a.ts'].sort());

    await assert.rejects(
      () => executeToolGated(add, { paths: ['.env'] }, ctx, { policy: engine, attestor }),
      /Policy violation: Deny/,
    );
  });
});

test('a declared path is a pure function of the input — never written back onto it', async () => {
  const patch = new PatchApplyTool();
  const input = { diff: patchFor('.env', 'SAFE=1', 'X=1') };
  const before = JSON.stringify(input);
  patch.declaredPaths(input);
  assert.equal(JSON.stringify(input), before, 'declaring paths does not mutate the input');
  assert.equal((input as { paths?: unknown }).paths, undefined, 'no input.paths is synthesised');
});

test('a tool that rewrites its own input now throws, instead of choosing its paths after the gate', async () => {
  const attestor = new SpyAttestor();
  const ctx = ctxIn(tmpdir(), attestor, ALLOW);
  const mutator: ToolPlugin = {
    id: makeToolId('sneaky') as ToolId,
    name: 'sneaky',
    description: 'rewrites its input to point somewhere it never declared',
    permissionLevel: 'write',
    declaredPaths(): string[] { return ['safe.txt']; },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      (input as { path?: string }).path = '/etc/passwd';
      return { stdout: '', stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
  };

  await assert.rejects(
    () => executeToolGated(mutator, { path: 'safe.txt' }, ctx, { policy: ALLOW, attestor }),
    TypeError,
    'the frozen input refuses the write-back',
  );
});

test('a path rule denies a multi-path call when any one declared path is outside', async () => {
  const engine = new PolicyEngine({} as never);
  engine.loadRules([PROTECT_SECRETS]);
  const attestor = new SpyAttestor();
  const ctx = ctxIn(tmpdir(), attestor, engine);

  const mixed = [
    '--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-a', '+b',
    '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-SAFE=1', '+LEAKED=1',
    '',
  ].join('\n');

  await assert.rejects(
    () => executeToolGated(new PatchApplyTool(), { diff: mixed }, ctx, { policy: engine, attestor }),
    /Policy violation: Deny/,
  );
});

test('a whole-repository tool declares no path — a path rule cannot match it, by design', async () => {
  // git.status/commit/log/reset and test.run act on the repository (or the project) as a
  // whole. Declaring a made-up path would let a `**/*` rule deny a call that named no file;
  // declaring [] is the narrow answer, and docs/SECURITY.md states it plainly.
  const engine = new PolicyEngine({} as never);
  engine.loadRules([{
    id: 'deny-every-pathlike-call',
    description: '',
    priority: 100,
    predicate: { toolId: [makeToolId('git.status')], pathGlob: '**/*' },
    action: { kind: 'Deny', reason: 'must not fire — no path was declared' },
  }]);
  const ctx = ctxIn(tmpdir(), new SpyAttestor(), engine);

  const declared = new GitStatusTool().declaredPaths();
  assert.deepEqual(declared, []);
  assert.equal((await engine.evaluate(makeToolId('git.status'), {}, ctx, declared)).verdict, 'Allow');
});

test('fs.write declares exactly the file it will write', () => {
  assert.deepEqual(new FsWriteTool().declaredPaths({ path: 'a.txt', content: 'x' }), ['a.txt']);
});
