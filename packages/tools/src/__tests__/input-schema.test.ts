import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolInput, ToolPlugin, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { describeToolInput, makeAgentId, makeRunId, makeTaskId, ToolDeclarationError } from '@maf/types';
import {
  createDefaultRegistry, FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool, GrepTool,
  GitAddTool, GitCommitTool, GitDiffTool, GitResetTool, PatchApplyTool,
} from '../index.js';
import type { GitExec } from '../plugins/git.js';

// ORACLE: WP-2.18, from the maintainer's live proof of 0.3.0 — `patch.apply` sent `{path, patch}`
// read an undefined `diff` and threw a TypeError from `writeFile`. Every built-in tool states the
// input its `execute` reads; `execute` itself answers a missing or mistyped required field with a
// failed result rather than a throw (the gate answers first; this is for a caller that bypassed it);
// `declaredPaths` on such an input still declares nothing it was not given — except `patch.apply`,
// which cannot declare nothing and write anyway: a call it cannot declare is refused (0.5.1).

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

const ctxIn = (root: string): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy: ALLOW, attestor: NO_ATTESTOR,
});

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-tool-input-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A git exec that records every call, so "git was not run" is observed. */
function noGit(): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: async (_file, args) => { calls.push(args); return { stdout: '', stderr: '' }; } };
}

/**
 * Each built-in tool's input, as the catalog advertises it — read off each tool's input interface and
 * what its `execute` reads, field by field. A field added to `execute` without its schema, or the other
 * way round, moves one of these.
 */
const ADVERTISED: Record<string, string> = {
  'fs.read':     '{"path": string (required), "offset": number, "limit": number}',
  'fs.write':    '{"path": string (required), "content": string (required), "createDirs": boolean}',
  'fs.delete':   '{"path": string (required), "recursive": boolean}',
  'fs.stat':     '{"path": string (required)}',
  'fs.list':     '{"path": string (required), "recursive": boolean}',
  'grep':        '{"pattern": string (required), "path": string, "glob": string, "ignoreCase": boolean, "maxResults": number, "context": number}',
  'git.status':  '{}',
  'git.diff':    '{"staged": boolean, "paths": string[], "path": string}',
  'git.add':     '{"paths": string[] (required)}',
  'git.commit':  '{"message": string (required), "allowEmpty": boolean}',
  'git.log':     '{"n": number, "oneline": boolean}',
  'git.reset':   '{"to": string (required), "hard": boolean}',
  'patch.apply': '{"diff": string (required), "strip": number, "dryRun": boolean}',
  'test.run':    '{"runner": "auto" | "bun" | "node" | "npm" | "pnpm" | "vitest" | "jest" | "pytest" | "cargo", "filter": string, "timeout": number}',
  'lcm.expand':  '{"summaryId": string (required)}',
};

test('every built-in tool declares a closed input schema, and it is the input its execute reads', () => {
  const tools = createDefaultRegistry().getAll();
  assert.equal(tools.length, 15);
  assert.deepEqual(tools.map((t) => String(t.id)).sort(), Object.keys(ADVERTISED).sort());
  for (const tool of tools) {
    const schema = tool.inputSchema;
    assert.ok(schema, `${tool.id} declares an inputSchema`);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${tool.id}: a field it does not read is refused`);
    for (const name of schema.required) assert.ok(Object.hasOwn(schema.properties, name), `${tool.id}: required "${name}" is declared`);
    for (const [name, field] of Object.entries(schema.properties)) {
      assert.ok(field.description.trim().length > 0, `${tool.id}: "${name}" says what it is`);
    }
    assert.equal(describeToolInput(schema), ADVERTISED[String(tool.id)], String(tool.id));
  }
});

test('execute answers a missing required field with a failed result naming it, and touches nothing', async (t) => {
  const root = await project(t);
  const git = noGit();
  const cases: Array<[ToolPlugin, ToolInput, string]> = [
    [new FsReadTool(),   {},                              '"path" is missing'],
    [new FsWriteTool(),  { path: 'a.txt' },               '"content" is missing'],
    [new FsWriteTool(),  { file: 'a.txt', text: 'x' },    '"path" and "content" are missing'],
    [new FsDeleteTool(), {},                              '"path" is missing'],
    [new FsStatTool(),   {},                              '"path" is missing'],
    [new FsListTool(),   {},                              '"path" is missing'],
    [new GrepTool(() => { throw new Error('grep must not be spawned'); }), { query: 'x' }, '"pattern" is missing'],
    [new GitAddTool(git.exec),    { path: 'a.txt' },      '"paths" is missing'],
    [new GitCommitTool(git.exec), { msg: 'x' },           '"message" is missing'],
    [new GitResetTool(git.exec),  { hard: true },         '"to" is missing'],
    [new PatchApplyTool(), { path: 'a.txt', patch: '--- a/a.txt\n+++ b/a.txt\n' }, '"diff" is missing'],
  ];
  for (const [tool, input, problem] of cases) {
    const result = await tool.execute(input, ctxIn(root));
    const label = `${tool.id} ${JSON.stringify(input)}`;
    assert.equal(result.exitCode, 1, label);
    assert.equal(result.stdout, '', label);
    assert.equal(result.stderr, `${tool.id} expects input ${ADVERTISED[String(tool.id)] ?? ''}; ${problem}.`, label);
  }
  assert.deepEqual(git.calls, [], 'git was never run');
  assert.deepEqual(await readdir(root), [], 'nothing was written');
});

test('execute answers a mistyped required field the same way', async (t) => {
  const root = await project(t);
  const git = noGit();
  const cases: Array<[ToolPlugin, ToolInput, string]> = [
    [new FsReadTool(),   { path: 5 },                     '"path" is a number, not a string'],
    [new FsWriteTool(),  { path: 'a.txt', content: 5 },   '"content" is a number, not a string'],
    [new FsWriteTool(),  { path: 'a.txt', content: null }, '"content" is null, not a string'],
    [new FsDeleteTool(), { path: ['a.txt'] },             '"path" is an array, not a string'],
    [new GitAddTool(git.exec),    { paths: 'a.txt' },     '"paths" is a string, not an array of strings'],
    [new GitAddTool(git.exec),    { paths: ['a.txt', 7] }, '"paths"[1] is a number, not a string'],
    [new GitCommitTool(git.exec), { message: 7 },          '"message" is a number, not a string'],
    [new PatchApplyTool(), { diff: { a: 1 } },             '"diff" is an object, not a string'],
  ];
  for (const [tool, input, problem] of cases) {
    const result = await tool.execute(input, ctxIn(root));
    assert.equal(result.stderr, `${tool.id} expects input ${ADVERTISED[String(tool.id)] ?? ''}; ${problem}.`, `${tool.id} ${JSON.stringify(input)}`);
    assert.equal(result.exitCode, 1);
  }
  assert.deepEqual(git.calls, [], 'git was never run');
  assert.deepEqual(await readdir(root), [], 'nothing was written');
});

test('execute checks only what it cannot run without: an unknown field from a direct caller is the gate\'s to refuse', async (t) => {
  const root = await project(t);
  const result = await new FsWriteTool().execute({ path: 'a.txt', content: 'x\n', mode: '0644' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(await readdir(root), ['a.txt']);
});

test('declaredPaths on a malformed input declares nothing it was not given; patch.apply refuses instead', () => {
  const malformed: ToolInput[] = [{}, { path: 5 }, { path: ['a'] }, { path: null }, { file: 'a.txt' }];
  const fsTools: ToolPlugin[] = [new FsReadTool(), new FsWriteTool(), new FsDeleteTool(), new FsStatTool(), new FsListTool()];
  for (const tool of fsTools) {
    for (const input of malformed) assert.deepEqual(tool.declaredPaths(input), [], `${tool.id} ${JSON.stringify(input)}`);
  }
  // `patch.apply` has no such answer: declaring nothing and then writing what the diff names is
  // exactly the reported bypass. The gate answers the malformed input before this is reached
  // (above); a caller that bypasses the gate gets a refusal, not an empty declaration.
  const patch: ToolPlugin = new PatchApplyTool();
  for (const input of [{}, { diff: 5 }, { path: 'hello.js', patch: '--- a/hello.js\n+++ b/hello.js\n' }]) {
    assert.throws(() => patch.declaredPaths(input), ToolDeclarationError, JSON.stringify(input));
  }
  const add: ToolPlugin = new GitAddTool();
  for (const input of [{}, { paths: 'a.txt' }, { paths: [1, null] }]) assert.deepEqual(add.declaredPaths(input), [], JSON.stringify(input));
  const diff: ToolPlugin = new GitDiffTool();
  assert.deepEqual(diff.declaredPaths({ paths: 3 }), []);
  // grep with no usable path searches the whole tree, so it declares the whole tree, as before.
  const grep: ToolPlugin = new GrepTool();
  assert.deepEqual(grep.declaredPaths({ path: 5 }), ['.']);
});
