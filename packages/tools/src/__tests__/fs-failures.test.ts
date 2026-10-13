import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolInput, ToolPlugin, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, PathEscapeError } from '@maf/types';
import { FsDeleteTool, FsListTool, FsReadTool, FsStatTool, FsWriteTool } from '../index.js';

// ORACLE: WP-2.18, round 2. A file that is not there is something a tool meets while running, and the
// model can act on it: each fs tool answers its own filesystem error with a failed result,
// `<id> failed: <message>`, the shape the gate gives a throw. Before, `fs.read` of a missing file threw
// ENOENT out of `execute`, and through the in-process loop that ended the node. A path outside the
// root is not that: it is a refusal, and still throws.

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

const ctxIn = (root: string): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy: ALLOW, attestor: NO_ATTESTOR,
});

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-fs-failures-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dir'));
  return root;
}

test('each fs tool answers a filesystem error with a failed result naming the tool and the error', async (t) => {
  const root = await project(t);
  // The syscall Node names in the message (`open`, `lstat`, `scandir`) is its own; the shape is ours.
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const enoent = (id: string, rel: string): RegExp =>
    new RegExp(`^${literal(id)} failed: ENOENT: no such file or directory, \\w+ '${literal(path.join(root, rel))}'$`);
  const cases: Array<[ToolPlugin, ToolInput, RegExp]> = [
    [new FsReadTool(),   { path: 'hello.js' },                     enoent('fs.read', 'hello.js')],
    [new FsReadTool(),   { path: 'dir' },                          /^fs\.read failed: EISDIR: illegal operation on a directory/],
    [new FsWriteTool(),  { path: 'src/hello.js', content: 'x\n' }, enoent('fs.write', 'src/hello.js')],
    [new FsDeleteTool(), { path: 'gone.txt' },                     enoent('fs.delete', 'gone.txt')],
    [new FsStatTool(),   { path: 'gone.txt' },                     enoent('fs.stat', 'gone.txt')],
    [new FsListTool(),   { path: 'nowhere' },                      enoent('fs.list', 'nowhere')],
  ];
  for (const [tool, input, stderr] of cases) {
    const result = await tool.execute(input, ctxIn(root));
    const label = `${tool.id} ${JSON.stringify(input)}`;
    assert.equal(result.exitCode, 1, label);
    assert.equal(result.stdout, '', label);
    assert.match(result.stderr, stderr, label);
  }
});

test('the corrected call succeeds: fs.write with createDirs makes the directory it was missing', async (t) => {
  const root = await project(t);
  const result = await new FsWriteTool().execute({ path: 'src/hello.js', content: 'x\n', createDirs: true }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'src', 'hello.js'), 'utf8'), 'x\n');
});

test('a path outside the root is still refused by a throw, not answered as a failure', async (t) => {
  const root = await project(t);
  for (const tool of [new FsReadTool(), new FsStatTool(), new FsListTool()] as ToolPlugin[]) {
    await assert.rejects(() => tool.execute({ path: '../elsewhere' }, ctxIn(root)), PathEscapeError, String(tool.id));
  }
  await assert.rejects(() => new FsWriteTool().execute({ path: '../elsewhere', content: 'x' }, ctxIn(root)), PathEscapeError);
});
