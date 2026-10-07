import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import {
  makeRunId, makeTaskId, makeAgentId, PathEscapeError,
} from '@maf/types';
import { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from '../plugins/fs.js';

// ORACLE (D-11/D-22; A2-4 exit criterion
// "`../` traversal, absolute escape and symlink escape are all refused for read *and* write").
//
// These call `execute` directly, with no gate and no policy, because that is the claim: a tool
// handed a path outside the project does not touch it. The gate's half of the same guarantee —
// which is what a model actually meets, since the policy engine's confinement runs first and
// refuses with a `Deny` the loop can report — is asserted against `PolicyEngine` in
// `@maf/policy-engine`.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

let parent: string;
/** The project root — what `ctx.projectRoot` names, and the only place these tools may write. */
let root: string;
/** A sibling directory outside it, holding the file every escape below aims at. */
let outside: string;

before(async () => {
  parent = await mkdtemp(path.join(tmpdir(), 'maf-fs-confine-'));
  root = path.join(parent, 'root');
  outside = path.join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'inside.txt'), 'inside\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');
  // `root/link.txt` is lexically inside the root and opens the file outside it; `alias.txt` is
  // the control — a link that stays inside, and must still work.
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(path.join(root, 'inside.txt'), path.join(root, 'alias.txt'));
});

after(async () => {
  await rm(parent, { recursive: true, force: true });
});

function ctxFor(projectRoot: string): ToolContext {
  return {
    cwd:         projectRoot,
    projectRoot,
    runId:       makeRunId('r-confinement'),
    taskId:      makeTaskId('t-confinement'),
    agentId:     makeAgentId('a-confinement'),
    sessionId:   's-confinement',
    policy:      ALLOW,
    attestor:    NO_ATTESTOR,
  };
}

/**
 * The three ways out of the root. A function rather than a constant because the fixture paths
 * only exist once `before` has run, and a module-level array would capture `undefined`.
 */
function escapes(): Array<[string, string]> {
  return [
    ['a relative traversal', '../outside/secret.txt'],
    ['an absolute path',     path.join(outside, 'secret.txt')],
    ['a symbolic link',      'link.txt'],
  ];
}

test('fs.read refuses a traversal, an absolute path and a symlink out of the root', async () => {
  const tool = new FsReadTool();
  for (const [what, p] of escapes()) {
    await assert.rejects(
      () => tool.execute({ path: p }, ctxFor(root)),
      PathEscapeError,
      `${what} must not be read`,
    );
  }
});

test('fs.write refuses the same three, and no file appears outside the root', async () => {
  const tool = new FsWriteTool();
  for (const [what, p] of escapes()) {
    await assert.rejects(
      () => tool.execute({ path: p, content: 'pwned\n' }, ctxFor(root)),
      PathEscapeError,
      `${what} must not be written`,
    );
  }

  // The refusal has to be observable on disk, not only as a thrown error: a tool that threw
  // after writing would pass an assertion that only looked at the rejection.
  assert.deepEqual((await readdir(outside)).sort(), ['secret.txt']);
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n',
    'the symlink target is untouched');
});

test('fs.delete refuses the same three, and the file outside is still there', async () => {
  const tool = new FsDeleteTool();
  for (const [what, p] of escapes()) {
    await assert.rejects(
      () => tool.execute({ path: p }, ctxFor(root)),
      PathEscapeError,
      `${what} must not be deleted through`,
    );
  }

  assert.deepEqual((await readdir(outside)).sort(), ['secret.txt']);
});

test('fs.stat and fs.list refuse the same three', async () => {
  for (const tool of [new FsStatTool(), new FsListTool()]) {
    for (const [what, p] of escapes()) {
      await assert.rejects(
        () => tool.execute({ path: p }, ctxFor(root)),
        PathEscapeError,
        `${what} must not be stat-ed or listed through ${tool.name}`,
      );
    }
  }
});

test('the three refusals are the root, not the tool: an in-root path is served normally', async () => {
  // Without this, a tool that refused every path would satisfy every assertion above.
  const ctx = ctxFor(root);

  assert.equal((await new FsReadTool().execute({ path: 'inside.txt' }, ctx)).stdout, 'inside\n');
  assert.deepEqual((await new FsListTool().execute({ path: '.' }, ctx)).stdout.split('\n').sort(),
    ['alias.txt', 'inside.txt', 'link.txt']);
  assert.equal((await new FsStatTool().execute({ path: 'inside.txt' }, ctx)).exitCode, 0);

  await new FsWriteTool().execute({ path: 'written.txt', content: 'ok\n' }, ctx);
  assert.equal(await readFile(path.join(root, 'written.txt'), 'utf8'), 'ok\n');

  // A path spelled differently is the same file, so a write through it lands in the root too.
  await new FsWriteTool().execute({ path: './sub/../written.txt', content: 'again\n' }, ctx);
  assert.equal(await readFile(path.join(root, 'written.txt'), 'utf8'), 'again\n');

  await new FsDeleteTool().execute({ path: 'written.txt' }, ctx);
  assert.ok(!(await readdir(root)).includes('written.txt'));
});

test('a symlink that stays inside the root is followed, not refused', async () => {
  assert.equal((await new FsReadTool().execute({ path: 'alias.txt' }, ctxFor(root))).stdout, 'inside\n');
});
