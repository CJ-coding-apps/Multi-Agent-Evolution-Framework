import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { GrepTool } from '../plugins/grep.js';
import type { GrepSpawn, GrepSpawnResult } from '../plugins/grep.js';

// ORACLE (D-12; audit P0 #7): a model-supplied pattern is searched for, never parsed as an option.
// `--pre=sh` is the case that matters: handed to rg as a bare argument it means "run every file
// through sh". The spy cases assert the argv itself; the real-binary cases prove rg and grep read
// that argv the way the spy says they should.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

/** Never touched by the spy cases — the spawn is a spy — so it only has to be absolute. */
const CWD = path.resolve('/repo');

function ctxIn(cwd: string): ToolContext {
  return {
    cwd,
    projectRoot: cwd,
    runId:       makeRunId('r-grep-args'),
    taskId:      makeTaskId('t-grep-args'),
    agentId:     makeAgentId('a-grep-args'),
    sessionId:   's-grep-args',
    policy:      ALLOW,
    attestor:    NO_ATTESTOR,
  };
}

interface SpawnCall { command: string; args: readonly string[]; cwd: string }

/** A spawn that records every call and answers from `reply`, so no search binary runs. */
function spy(reply: (command: string) => GrepSpawnResult): { spawn: GrepSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: GrepSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    return reply(command);
  };
  return { spawn, calls };
}

const FOUND: GrepSpawnResult = { stdout: 'hit\n', stderr: '', status: 0 };
/** What `spawnSync` returns when the binary is not installed: no output, an `error`. */
const NOT_INSTALLED: GrepSpawnResult = {
  stdout: null, stderr: null, status: null, error: new Error('spawnSync rg ENOENT'),
};

/** Patterns each of which is an option to rg, to grep, or to both when passed bare. */
const OPTION_SHAPED = ['--pre=sh', '-r', '--files', '-e', '--', '-'];

function onPath(binary: string): boolean {
  return spawnSync(binary, ['--version'], { encoding: 'utf8' }).error === undefined;
}

test('grep hands rg the pattern after -e and the path after --, so an option-shaped pattern is a pattern', async () => {
  for (const pattern of OPTION_SHAPED) {
    const { spawn, calls } = spy(() => FOUND);
    const r = await new GrepTool(spawn).execute({ pattern }, ctxIn(CWD));

    assert.deepEqual(calls, [{
      command: 'rg',
      args:    ['--line-number', '--no-heading', '-e', pattern, '--', CWD],
      cwd:     CWD,
    }], `pattern ${JSON.stringify(pattern)}`);
    assert.equal(r.stdout, 'hit\n');
  }
});

test('grep binds every model-supplied flag value to its flag, so none of them stands alone', async () => {
  // A real root: a named path is resolved inside it (WP-2.18), which the filesystem has to answer.
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-grep-flags-')));
  try {
    await mkdir(path.join(root, 'src'));
    const { spawn, calls } = spy(() => FOUND);
    await new GrepTool(spawn).execute({
      pattern:    'needle',
      path:       'src',
      glob:       '--pre=sh',
      ignoreCase: true,
      maxResults: 5,
      context:    2,
    }, ctxIn(root));

    assert.deepEqual(calls.map((c) => c.args), [[
      '--line-number', '--no-heading',
      '--ignore-case', '--max-count=5', '--context=2', '--glob=--pre=sh',
      '-e', 'needle', '--', path.join(root, 'src'),
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// WP-2.18: grep's path is resolved inside the project root like every other tool's. It was
// `path.resolve(ctx.cwd, …)`, so a direct call searched wherever `../` or an absolute path led.
test('grep refuses a path that leaves the project root with a failed result, and searches nothing', async () => {
  const parent = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-grep-confine-')));
  try {
    const root = path.join(parent, 'root');
    await mkdir(root);
    await mkdir(path.join(parent, 'outside'));
    await symlink(path.join(parent, 'outside'), path.join(root, 'link'));
    for (const escape of ['../outside', path.join(parent, 'outside'), 'link']) {
      const { spawn, calls } = spy(() => FOUND);
      const r = await new GrepTool(spawn).execute({ pattern: 'secret', path: escape }, ctxIn(root));
      assert.equal(r.exitCode, 1, escape);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^grep failed: Path ".*" is outside the project root /, escape);
      assert.deepEqual(calls, [], `${escape}: nothing was searched`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the grep fallback takes the same -e/-- shape when rg is not installed', async () => {
  for (const pattern of OPTION_SHAPED) {
    for (const ignoreCase of [false, true]) {
      const { spawn, calls } = spy((command) => (command === 'rg' ? NOT_INSTALLED : FOUND));
      const r = await new GrepTool(spawn).execute({ pattern, ignoreCase }, ctxIn(CWD));

      assert.equal(calls.length, 2, 'rg is tried first, then grep');
      assert.equal(calls[0]?.command, 'rg');
      assert.deepEqual(calls[1], {
        command: 'grep',
        args:    ['-rn', ...(ignoreCase ? ['-i'] : []), '-e', pattern, '--', CWD],
        cwd:     CWD,
      }, `pattern ${JSON.stringify(pattern)}, ignoreCase ${String(ignoreCase)}`);
      assert.equal(r.stdout, 'hit\n', 'the result is grep\'s');
    }
  }
});

/** Two files hold the literal text; the glob admits only one of them, and a third holds neither. */
async function withCorpus(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-grep-args-'));
  try {
    await writeFile(path.join(dir, 'notes.txt'), 'plain line\n--pre=sh\n', 'utf8');
    await writeFile(path.join(dir, 'other.md'), '--pre=sh\n', 'utf8');
    await writeFile(path.join(dir, 'clean.txt'), 'nothing to see\n', 'utf8');
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('real rg searches for "--pre=sh" as text and still applies the glob', {
  skip: onPath('rg') ? false : 'ripgrep is not on PATH',
}, async () => {
  await withCorpus(async (dir) => {
    const r = await new GrepTool().execute({ pattern: '--pre=sh', glob: '*.txt' }, ctxIn(dir));

    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /notes\.txt:2:--pre=sh/);
    assert.doesNotMatch(r.stdout, /other\.md/, 'the glob is honoured in its bound form');
    assert.doesNotMatch(r.stdout, /clean\.txt/);
  });
});

test('real grep (the fallback) searches for "--pre=sh" as text', {
  skip: onPath('grep') ? false : 'grep is not on PATH',
}, async () => {
  // rg is reported missing so the fallback runs; grep itself is the real binary.
  const noRg: GrepSpawn = (command, args, options) =>
    command === 'rg' ? NOT_INSTALLED : spawnSync(command, args, options);

  await withCorpus(async (dir) => {
    const r = await new GrepTool(noRg).execute({ pattern: '--pre=sh' }, ctxIn(dir));

    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /notes\.txt:2:--pre=sh/);
    assert.match(r.stdout, /other\.md:1:--pre=sh/);
    assert.doesNotMatch(r.stdout, /clean\.txt/);
  });
});
