import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolId, PolicyDecision } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyLoader } from '../PolicyLoader.js';
import type { PolicyEngine } from '../PolicyEngine.js';

// ORACLE (D-09): "Tool writes to `.git/**` and `.maf/**` are denied by default ... `.gitignore`,
// `.gitattributes` and a `.githooks/` directory live outside `.git/` and remain writable."
//
// Asserted against the file the repository ships, loaded the way a run loads it, so the test
// fails if the rule is dropped, mistyped, outranked, or the file stops loading at all.

// dist/__tests__ → package → packages → repository root.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SHIPPED_POLICY = path.join(REPO_ROOT, '.maf', 'policy.yaml');

// No shipped rule sets `memoryPattern`, so a typed stub for the graph is sufficient.
const stubGraph = {} as never;

const FS_WRITE    = makeToolId('fs.write');
const FS_DELETE   = makeToolId('fs.delete');
const FS_READ     = makeToolId('fs.read');
const PATCH_APPLY = makeToolId('patch.apply');
const GIT_ADD     = makeToolId('git.add');

let projectRoot = '';
let engine: PolicyEngine;

before(async () => {
  // A real root with a real .git/hooks and .maf, so the paths are confined the way a run's are.
  projectRoot = await mkdtemp(path.join(tmpdir(), 'maf-shipped-policy-'));
  await mkdir(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
  await mkdir(path.join(projectRoot, '.maf'), { recursive: true });
  engine = await PolicyLoader.loadEngine(SHIPPED_POLICY, stubGraph);
});

after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function ctxFor(agentRole: string | undefined): ToolContext {
  return {
    cwd:         projectRoot,
    projectRoot,
    runId:       makeRunId('r1'),
    taskId:      makeTaskId('t1'),
    agentId:     makeAgentId('a1'),
    sessionId:   's1',
    policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
    attestor:    { record: async () => undefined } as never,
    ...(agentRole === undefined ? {} : { agentRole }),
  };
}

function evaluate(toolId: ToolId, file: string, agentRole: string | undefined = 'coder'): Promise<PolicyDecision> {
  return engine.evaluate(toolId, { path: file }, ctxFor(agentRole), [file]);
}

function reasonOf(decision: PolicyDecision): string {
  return decision.verdict === 'Deny' ? decision.reason : `(not a Deny: ${decision.verdict})`;
}

// Every shipped role, a custom role no rule names, and a call with no role at all.
const EVERY_ROLE: Array<string | undefined> = ['coder', 'tester', 'reviewer', 'security', 'docs-writer', undefined];

test('the shipped policy loads through PolicyLoader with every rule it ships', async () => {
  const ids = (await PolicyLoader.load(SHIPPED_POLICY)).map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'coder-no-secrets-dir', 'deny-env-files', 'deny-git-dir', 'deny-maf-dir', 'deny-readonly-roles',
    'protect-lock-files', 'protect-migrations', 'tester-write-only-tests',
  ]);
});

test('fs.write to .git/hooks/pre-commit is denied for every role, and .gitignore is allowed', async () => {
  for (const role of EVERY_ROLE) {
    const hook = await evaluate(FS_WRITE, '.git/hooks/pre-commit', role);
    assert.equal(hook.verdict, 'Deny', `role ${String(role)}`);
    // The .git rule's own reason, so this is that rule firing and not a role rule that happens
    // to deny the same call (the tester and read-only rules would).
    assert.match(reasonOf(hook), /under \.git\//, `role ${String(role)}`);
  }

  // Allowed for every role that may write outside tests at all: the other shipped roles are
  // refused `.gitignore` by their own rules (tester: tests only; reviewer/security: read-only).
  for (const role of ['coder', 'docs-writer', undefined]) {
    assert.equal((await evaluate(FS_WRITE, '.gitignore', role)).verdict, 'Allow', `role ${String(role)}`);
  }
});

test('every path-declaring write tool is refused under .git, at any depth, and on .git itself', async () => {
  const paths = [
    '.git/hooks/pre-commit',
    '.git/config',              // core.hooksPath / core.fsmonitor run commands the same way
    '.git',                     // a worktree's .git file redirects git wholesale
    'vendor/lib/.git/hooks/post-checkout',
  ];
  for (const toolId of [FS_WRITE, FS_DELETE, PATCH_APPLY, GIT_ADD]) {
    for (const file of paths) {
      const decision = await evaluate(toolId, file);
      assert.equal(decision.verdict, 'Deny', `${toolId} ${file}`);
      assert.match(reasonOf(decision), /under \.git\//, `${toolId} ${file}`);
    }
  }
});

test('every path-declaring write tool is refused under .maf, and on .maf itself', async () => {
  for (const toolId of [FS_WRITE, FS_DELETE, PATCH_APPLY, GIT_ADD]) {
    for (const file of ['.maf/policy.yaml', '.maf/roles.yaml', '.maf/attestations/run.json', '.maf']) {
      const decision = await evaluate(toolId, file);
      assert.equal(decision.verdict, 'Deny', `${toolId} ${file}`);
      assert.match(reasonOf(decision), /under \.maf\//, `${toolId} ${file}`);
    }
  }
});

test('the .git rule outranks the lock-file Escalate, so .git/index.lock is denied, not escalated', async () => {
  // `**/*.lock` matches `.git/index.lock` now that globs match dotfiles. An Escalate is a question
  // a human may answer yes to; a write into .git is not one.
  assert.equal((await evaluate(FS_WRITE, '.git/index.lock')).verdict, 'Deny');
});

test('what D-09 leaves writable stays writable, and reading .git is unaffected', async () => {
  for (const file of ['.gitignore', '.gitattributes', '.githooks/pre-commit', '.mafrc', 'docs/.maf-notes.txt']) {
    assert.equal((await evaluate(FS_WRITE, file)).verdict, 'Allow', file);
  }
  assert.equal((await evaluate(FS_READ, '.git/HEAD')).verdict, 'Allow');
  assert.equal((await evaluate(FS_READ, '.maf/policy.yaml')).verdict, 'Allow');
});
