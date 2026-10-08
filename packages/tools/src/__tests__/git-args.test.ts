import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ToolContext, ToolInput, ToolPlugin, PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import {
  GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool,
} from '../plugins/git.js';
import type { GitExec } from '../plugins/git.js';

// ORACLE (D-12; audit P0 #7): no model-supplied string reaches git's argv where git could read it
// as an option, every git tool runs with literal pathspecs, and git.diff diffs exactly the paths it
// declared to policy.
//
// The tools are driven through `ToolPlugin`, typed on `ToolInput`, because that is how a model's
// call reaches them: as parsed JSON that the input interfaces describe but nothing enforces.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

/** Never touched by the spy cases — the exec is a spy — so it only has to be absolute. */
const CWD = path.resolve('/repo');

function ctxIn(cwd: string): ToolContext {
  return {
    cwd,
    projectRoot: cwd,
    runId:       makeRunId('r-git-args'),
    taskId:      makeTaskId('t-git-args'),
    agentId:     makeAgentId('a-git-args'),
    sessionId:   's-git-args',
    policy:      ALLOW,
    attestor:    NO_ATTESTOR,
  };
}

interface ExecCall { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** An exec that records every call and succeeds with no output, so no git runs. */
function spy(): { exec: GitExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: GitExec = async (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, env: options.env });
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function onPath(binary: string): boolean {
  return spawnSync(binary, ['--version'], { encoding: 'utf8' }).error === undefined;
}

// ── git.log ───────────────────────────────────────────────────────────────────

test('git.log passes a checked count as -N, defaulting to 10', async () => {
  const cases: Array<[ToolInput, string[]]> = [
    [{},                        ['log', '-10', '--oneline']],
    [{ n: 3 },                  ['log', '-3', '--oneline']],
    [{ n: 1, oneline: false },  ['log', '-1']],
    [{ n: Number.MAX_SAFE_INTEGER }, ['log', `-${Number.MAX_SAFE_INTEGER}`, '--oneline']],
  ];
  for (const [input, argv] of cases) {
    const { exec, calls } = spy();
    const tool: ToolPlugin = new GitLogTool(exec);
    await tool.execute(input, ctxIn(CWD));
    assert.deepEqual(calls.map((c) => c.args), [argv], JSON.stringify(input));
  }
});

test('git.log rejects any n that is not a positive safe integer, before anything is spawned', async () => {
  const { exec, calls } = spy();
  const tool: ToolPlugin = new GitLogTool(exec);
  const refused: unknown[] = [
    '--output=/tmp/x', '-output=/tmp/x', '5', '', 0, -1, -0, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, null, true, [3], { n: 3 },
  ];
  for (const n of refused) {
    await assert.rejects(
      () => tool.execute({ n }, ctxIn(CWD)),
      /git\.log expects "n" to be a positive whole number of commits, but got /,
      `n = ${String(n)}`,
    );
  }
  assert.equal(calls.length, 0, 'no refused count reached git');
});

// ── git.reset ─────────────────────────────────────────────────────────────────

test('git.reset puts --end-of-options before a revision it has checked', async () => {
  const accepted = [
    'HEAD', 'HEAD~', 'HEAD~1', 'HEAD~12', 'HEAD^', 'HEAD^2',
    'a1b2c3d', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'main', 'feature/x-1_y.2', 'v1.0.0', 'release/0.2.1',
  ];
  for (const to of accepted) {
    for (const hard of [false, true]) {
      const { exec, calls } = spy();
      const tool: ToolPlugin = new GitResetTool(exec);
      await tool.execute({ to, hard }, ctxIn(CWD));
      assert.deepEqual(
        calls.map((c) => c.args),
        [['reset', hard ? '--hard' : '--soft', '--end-of-options', to]],
        `to = ${to}, hard = ${String(hard)}`,
      );
    }
  }
});

test('git.reset rejects a "to" that is not a plain revision, before anything is spawned', async () => {
  const { exec, calls } = spy();
  const tool: ToolPlugin = new GitResetTool(exec);
  const refused: unknown[] = [
    '--hard', '-q', '--output=/tmp/x', '-', '-main', '',
    'HEAD@{1}', '@{u}', 'HEAD:src/a.ts', 'HEAD~-1', 'HEAD~1~2', 'main;rm -rf /', 'a b', 'main\n', 'ma$in',
    5, null, undefined, true, ['HEAD'], { to: 'HEAD' },
  ];
  for (const to of refused) {
    await assert.rejects(
      () => tool.execute({ to, hard: true }, ctxIn(CWD)),
      /git\.reset expects "to" to be a commit hash, HEAD, HEAD~N, HEAD\^N, or a branch or tag name/,
      `to = ${typeof to === 'string' ? JSON.stringify(to) : String(to)}`,
    );
  }
  assert.equal(calls.length, 0, 'no refused revision reached git');
});

// ── git.diff ──────────────────────────────────────────────────────────────────

test('git.diff declares and diffs one list, with the legacy path folded into paths', async () => {
  const cases: Array<[string, ToolInput, string[], string[]]> = [
    ['paths',               { paths: ['a.ts', 'b.ts'] },              ['a.ts', 'b.ts'], ['diff', '--', 'a.ts', 'b.ts']],
    ['legacy path',         { path: 'a.ts' },                         ['a.ts'],         ['diff', '--', 'a.ts']],
    ['both, staged',        { paths: ['a.ts'], path: 'b.ts', staged: true },
                                                                      ['a.ts', 'b.ts'], ['diff', '--staged', '--', 'a.ts', 'b.ts']],
    ['both, same file',     { paths: ['a.ts'], path: 'a.ts' },        ['a.ts'],         ['diff', '--', 'a.ts']],
    ['neither',             {},                                       [],               ['diff']],
    ['empty paths, path',   { paths: [], path: '.env' },              ['.env'],         ['diff', '--', '.env']],
    ['non-strings dropped', { paths: ['a.ts', 7, '', null], path: 3 }, ['a.ts'],        ['diff', '--', 'a.ts']],
    ['option-shaped path',  { paths: ['--output=/tmp/x'] },           ['--output=/tmp/x'], ['diff', '--', '--output=/tmp/x']],
    // Frozen, as `executeToolGated` freezes it: folding `path` in must not write to the input.
    ['frozen input',        Object.freeze({ paths: Object.freeze(['a.ts']), path: 'b.ts' }),
                                                                      ['a.ts', 'b.ts'], ['diff', '--', 'a.ts', 'b.ts']],
  ];
  for (const [what, input, declared, argv] of cases) {
    const { exec, calls } = spy();
    const tool: ToolPlugin = new GitDiffTool(exec);

    assert.deepEqual(tool.declaredPaths(input), declared, `${what}: declared`);
    await tool.execute(input, ctxIn(CWD));
    assert.deepEqual(calls.map((c) => c.args), [argv], `${what}: executed`);

    const executed = calls[0]?.args ?? [];
    const sep = executed.indexOf('--');
    assert.deepEqual(sep === -1 ? [] : executed.slice(sep + 1), tool.declaredPaths(input),
      `${what}: git diffs exactly the paths policy was shown`);
  }
});

// ── the helper's environment ─────────────────────────────────────────────────

test('every git tool runs with GIT_LITERAL_PATHSPECS=1 and the rest of the environment unchanged', async () => {
  const { exec, calls } = spy();
  const runs: Array<[ToolPlugin, ToolInput]> = [
    [new GitStatusTool(exec), {}],
    [new GitDiffTool(exec),   { paths: ['a.ts'] }],
    [new GitAddTool(exec),    { paths: ['a.ts'] }],
    [new GitCommitTool(exec), { message: 'm' }],
    [new GitLogTool(exec),    {}],
    [new GitResetTool(exec),  { to: 'HEAD' }],
  ];
  for (const [tool, input] of runs) await tool.execute(input, ctxIn(CWD));

  assert.equal(calls.length, runs.length, 'one git call per tool');
  for (const [i, call] of calls.entries()) {
    const name = runs[i]?.[0].name ?? '';
    assert.equal(call.file, 'git', name);
    assert.equal(call.cwd, CWD, name);
    assert.deepEqual(call.env, { ...process.env, GIT_LITERAL_PATHSPECS: '1' }, name);
  }
});

test('real git, through git.add, treats a glob as a file name and stages nothing', {
  skip: onPath('git') ? false : 'git is not on PATH',
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-git-args-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0, 'git init');
    await writeFile(path.join(dir, '.env'), 'SECRET=1\n', 'utf8');

    // With pathspec magic, `*.env` matches `.env` — a file no rule written for `.env` was shown.
    const r = await new GitAddTool().execute({ paths: ['*.env'] }, ctxIn(dir));
    assert.notEqual(r.exitCode, 0, 'a literal "*.env" names no file, so git refuses');

    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
    assert.equal(staged.stdout, '', 'nothing was staged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
