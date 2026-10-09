import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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

/**
 * Never written by the spy cases — the exec is a spy — but it must exist: every tool resolves its
 * project root before it asks git anything (F1 of the 0.3.0 audit).
 */
const CWD = realpathSync(tmpdir());

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

/**
 * The config every git call from the tools pins ahead of its subcommand (WP-2.14), written out
 * here rather than imported so that a change to it has to change this oracle too.
 */
const ISOLATION = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'commit.gpgsign=false'];

/**
 * `argv` is what git was handed; `args` is the subcommand onward, once the isolation prefix is
 * matched — or the whole argv when it is not, so a missing prefix fails every argv assertion.
 */
interface ExecCall { file: string; argv: string[]; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** The question each tool asks git before every call: which working tree is this? */
const PROBE = ['rev-parse', '--show-toplevel'];

function isProbe(args: readonly string[]): boolean {
  return args.length === ISOLATION.length + PROBE.length && PROBE.every((a, i) => args[ISOLATION.length + i] === a);
}

/**
 * An exec that records every call and succeeds with no output, so no git runs. The working-tree
 * probe is answered with the call's own directory — the tree is the project root — and recorded
 * apart, so `calls` is what the tool asked git to do.
 */
function spy(): { exec: GitExec; calls: ExecCall[]; probes: ExecCall[] } {
  const calls: ExecCall[] = [];
  const probes: ExecCall[] = [];
  const exec: GitExec = async (file, args, options) => {
    const isolated = ISOLATION.every((a, i) => args[i] === a);
    (isProbe(args) ? probes : calls).push({
      file, argv: [...args], args: isolated ? args.slice(ISOLATION.length) : [...args],
      cwd: options.cwd, env: options.env,
    });
    return { stdout: isProbe(args) ? `${options.cwd}\n` : '', stderr: '' };
  };
  return { exec, calls, probes };
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

test('git.reset ends its argv with -- so a checked revision is read as a revision', async () => {
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
        [['reset', hard ? '--hard' : '--soft', to, '--']],
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

/** Variables through which a host hands git configuration without a file (WP-2.14). */
const HOST_CONFIG_VARS = {
  GIT_CONFIG:            '/tmp/host-gitconfig',
  GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/tmp/host-fsmonitor'",
  GIT_CONFIG_COUNT:      '1',
  GIT_CONFIG_KEY_0:      'diff.external',
  GIT_CONFIG_VALUE_0:    '/tmp/host-diff',
};

/**
 * The opposite of each value the tools pin, so the assertion below holds because the tools set
 * them and not because the machine running the test already exported the same values.
 */
const HOST_PINNED_VARS = {
  GIT_CONFIG_GLOBAL:     '/tmp/host-global',
  GIT_CONFIG_NOSYSTEM:   '0',
  GIT_TERMINAL_PROMPT:   '1',
  GIT_LITERAL_PATHSPECS: '0',
  GIT_CEILING_DIRECTORIES: '/tmp/host-ceiling',
};

/**
 * Variables through which a host names the repository git works on — what a git hook that starts
 * MAF passes down (F1 of the 0.3.0 audit). Each would point the agent's git at the user's checkout.
 */
const HOST_REPOSITORY_VARS = {
  GIT_DIR:                          '/tmp/host-repo/.git',
  GIT_WORK_TREE:                    '/tmp/host-repo',
  GIT_INDEX_FILE:                   '/tmp/host-repo/.git/index',
  GIT_COMMON_DIR:                   '/tmp/host-repo/.git',
  GIT_OBJECT_DIRECTORY:             '/tmp/host-repo/.git/objects',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/host-alternates',
  GIT_DISCOVERY_ACROSS_FILESYSTEM:  '1',
};

test('every git tool runs isolated: hooks, fsmonitor and signing pinned off, host config and repository ignored, no prompt, literal pathspecs, discovery ceiling at the tree', async () => {
  // The variables are set on this process for the length of the test because the tools read
  // process.env, as they would in a shell that exported them.
  const host = { ...HOST_CONFIG_VARS, ...HOST_PINNED_VARS, ...HOST_REPOSITORY_VARS };
  const saved = Object.keys(host).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, host);
  const { exec, calls, probes } = spy();
  try {
    const runs: Array<[ToolPlugin, ToolInput]> = [
      [new GitStatusTool(exec), {}],
      [new GitDiffTool(exec),   { paths: ['a.ts'] }],
      [new GitAddTool(exec),    { paths: ['a.ts'] }],
      [new GitCommitTool(exec), { message: 'm' }],
      [new GitLogTool(exec),    {}],
      [new GitResetTool(exec),  { to: 'HEAD' }],
    ];
    for (const [tool, input] of runs) await tool.execute(input, ctxIn(CWD));

    // Everything the host exported reaches git except its config: PATH, HOME, the locale. The
    // counted form is dropped whole — every KEY_n/VALUE_n the host has, not only the ones set here.
    const expected: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(expected)) {
      if (k in HOST_CONFIG_VARS || k in HOST_REPOSITORY_VARS || /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/.test(k)) delete expected[k];
    }
    Object.assign(expected, {
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(CWD),
    });

    // git.commit asks the repository for its identity first; the spy's empty answer is "none".
    assert.deepEqual(calls.map((c) => c.args), [
      ['status', '--porcelain=v2', '--branch'],
      ['diff', '--', 'a.ts'],
      ['add', '--', 'a.ts'],
      ['config', '-z', '--get-regexp', '^user\\.(name|email)$'],
      ['-c', 'user.name=maf', '-c', 'user.email=maf@maf.invalid', 'commit', '-m', 'm'],
      ['log', '-10', '--oneline'],
      ['reset', '--soft', 'HEAD', '--'],
    ]);
    for (const call of calls) {
      const what = call.argv.join(' ');
      assert.equal(call.file, 'git', what);
      assert.equal(call.cwd, CWD, what);
      assert.deepEqual(call.argv.slice(0, ISOLATION.length), ISOLATION, `${what}: the isolation prefix comes first`);
      assert.deepEqual(call.env, expected, what);
    }
    // Every call was preceded by the working-tree probe, run where and how the call itself ran.
    assert.equal(probes.length, calls.length, 'one probe per git call');
    for (const probe of probes) {
      assert.equal(probe.cwd, CWD);
      assert.deepEqual(probe.argv.slice(0, ISOLATION.length), ISOLATION);
      assert.deepEqual(probe.env, expected);
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('git.commit keeps whichever of user.name and user.email the repository sets, and names maf for the rest', async () => {
  const cases: Array<[string, string, string[]]> = [
    ['both set',       'user.name\nAlice\0user.email\nalice@example.com\0', []],
    ['email only',     'user.email\nalice@example.com\0',                   ['-c', 'user.name=maf']],
    ['name only',      'user.name\nAlice\0',                                ['-c', 'user.email=maf@maf.invalid']],
    // git uses the last value; an empty one is no identity, and a valueless key is not a name.
    ['last is empty',  'user.name\nAlice\0user.name\n\0user.email\na@x\0',  ['-c', 'user.name=maf']],
    ['valueless name', 'user.name\0user.email\na@x\0',                      ['-c', 'user.name=maf']],
    ['none',           '',                                                  ['-c', 'user.name=maf', '-c', 'user.email=maf@maf.invalid']],
  ];
  for (const [what, configured, identity] of cases) {
    const calls: ExecCall[] = [];
    const exec: GitExec = async (file, args, options) => {
      if (isProbe(args)) return { stdout: `${options.cwd}\n`, stderr: '' };
      calls.push({ file, argv: [...args], args: args.slice(ISOLATION.length), cwd: options.cwd, env: options.env });
      return { stdout: args.includes('config') ? configured : '', stderr: '' };
    };
    await new GitCommitTool(exec).execute({ message: 'm' }, ctxIn(CWD));
    assert.deepEqual(calls[1]?.args, [...identity, 'commit', '-m', 'm'], what);
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
