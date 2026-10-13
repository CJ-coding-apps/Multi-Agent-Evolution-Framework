import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import {
  GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool,
} from '../plugins/git.js';
import { FsWriteTool } from '../plugins/fs.js';

// ORACLE (WP-2.14; verifier finding F12 on WP-2.10): a git call from the agent's tools runs no
// hook — not one the repository configures, not one the agent wrote into the working tree — and
// reads none of the host's git configuration, while the commit itself still lands, as the
// repository's own identity when it has one.
//
// Real git in temp repositories, because the claim is about what git does with the argv and
// environment, not what the argv is. Every case ends with a control: the same setup driven by
// plain git does run the hook (or break the commit), so a passing case is not a vacuous one.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

function ctxIn(cwd: string): ToolContext {
  return {
    cwd,
    projectRoot: cwd,
    runId:       makeRunId('r-git-isolation'),
    taskId:      makeTaskId('t-git-isolation'),
    agentId:     makeAgentId('a-git-isolation'),
    sessionId:   's-git-isolation',
    policy:      ALLOW,
    attestor:    NO_ATTESTOR,
  };
}

const NEEDS_GIT = {
  skip: process.platform === 'win32' ? 'the hooks here are sh scripts'
    : spawnSync('git', ['--version']).error === undefined ? false : 'git is not on PATH',
};

/**
 * The environment the fixtures and controls run git in: no GIT_* from this process and no host
 * config file, so neither the machine running the test nor a case's hostile variables shape the
 * fixture — but nothing pinned, so a control runs whatever the repository configures.
 */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

function plain(cwd: string, args: string[], env: NodeJS.ProcessEnv = plainEnv()): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function must(cwd: string, args: string[]): string {
  const r = plain(cwd, args);
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A script that appends its own name to `marker`, so a control can say which hooks ran. */
async function markerScript(file: string, marker: string, exitCode = 0): Promise<void> {
  await writeFile(file, `#!/bin/sh\necho "$(basename "$0")" >> '${marker}'\nexit ${exitCode}\n`, 'utf8');
  await chmod(file, 0o755);
}

/**
 * A repository with one commit and, unless `identity` is null, a repo-local user. The first
 * commit names its identity on the command line so that the repository config holds only what
 * the case asked for.
 */
async function fixture(t: TestContext, identity: { name?: string; email?: string } | null): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-git-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  must(repo, ['init', '-q', '-b', 'main']);
  if (identity?.name !== undefined) must(repo, ['config', 'user.name', identity.name]);
  if (identity?.email !== undefined) must(repo, ['config', 'user.email', identity.email]);
  await writeFile(path.join(repo, 'README.md'), '# r\n', 'utf8');
  must(repo, ['add', 'README.md']);
  must(repo, ['-c', 'user.name=setup', '-c', 'user.email=setup@maf.invalid', 'commit', '-q', '-m', 'initial']);
  return { root, repo };
}

function head(repo: string, format: string): string {
  return must(repo, ['log', '-1', `--format=${format}`]).trim();
}

// ── F12: the verifier's scenario ──────────────────────────────────────────────

test('F12: an agent-written .husky/pre-commit under a relative core.hooksPath does not run, and git.commit still commits', NEEDS_GIT, async (t) => {
  const { repo } = await fixture(t, { name: 'Alice', email: 'alice@example.com' });
  // The user's husky setup: an executable, committed hook, and core.hooksPath relative to the
  // working tree — which is where the agent writes.
  await mkdir(path.join(repo, '.husky'));
  await writeFile(path.join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path.join(repo, '.husky', 'pre-commit'), 0o755);
  must(repo, ['add', '.husky']);
  must(repo, ['commit', '-q', '-m', 'husky']);
  must(repo, ['config', 'core.hooksPath', '.husky']);

  const ctx = ctxIn(repo);
  const write = new FsWriteTool();
  await write.execute({ path: '.husky/pre-commit', content: '#!/bin/sh\necho pwned > PWNED.txt\n' }, ctx);
  await write.execute({ path: 'feature.ts', content: 'export const x = 1;\n' }, ctx);
  const mode = (await stat(path.join(repo, '.husky', 'pre-commit'))).mode;
  assert.notEqual(mode & 0o111, 0, 'premise: fs.write kept the hook executable, so git would run it');

  const added = await new GitAddTool().execute({ paths: ['.husky/pre-commit', 'feature.ts'] }, ctx);
  assert.equal(added.exitCode, 0, added.stderr);
  const committed = await new GitCommitTool().execute({ message: 'agent commit' }, ctx);
  assert.equal(committed.exitCode, 0, committed.stderr);
  // `/dev/null/pre-commit` cannot exist, so git does not even hint at an ignored hook.
  assert.equal(committed.stderr, '', 'git says nothing on stderr');

  const pwned = path.join(repo, 'PWNED.txt');
  assert.equal(existsSync(pwned), false, 'the agent-written hook must not run');
  assert.equal(head(repo, '%s|%an <%ae>|%cn <%ce>'), 'agent commit|Alice <alice@example.com>|Alice <alice@example.com>',
    'the commit lands, as the repository\'s identity');
  assert.equal(must(repo, ['status', '--porcelain']), '', 'everything staged was committed');

  // Control: the same repository, committed to by plain git, runs the agent's hook.
  const control = plain(repo, ['commit', '-q', '--allow-empty', '-m', 'control']);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(existsSync(pwned), true, 'plain git runs the hook, or this test proves nothing');
});

// ── acceptance 3: a repository's own hooks, every tool ───────────────────────

const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction'];

for (const where of ['.git/hooks', 'a repo-local core.hooksPath'] as const) {
  test(`hooks in ${where} are ignored by every git tool, and each tool still does its job`, NEEDS_GIT, async (t) => {
    const { root, repo } = await fixture(t, { name: 'Alice', email: 'alice@example.com' });
    const marker = path.join(root, 'hooks-ran');
    const dir = where === '.git/hooks' ? path.join(repo, '.git', 'hooks') : path.join(root, 'repo-hooks');
    await mkdir(dir, { recursive: true });
    for (const hook of HOOKS) await markerScript(path.join(dir, hook), marker);
    if (where !== '.git/hooks') must(repo, ['config', 'core.hooksPath', dir]);
    const initial = must(repo, ['rev-parse', 'HEAD']).trim();
    const ctx = ctxIn(repo);

    await writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n', 'utf8');
    const status = await new GitStatusTool().execute({}, ctx);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.match(status.stdout, /^\? a\.ts$/m, 'git.status lists the new file');

    const add = await new GitAddTool().execute({ paths: ['a.ts'] }, ctx);
    assert.equal(add.exitCode, 0, add.stderr);
    const staged = await new GitDiffTool().execute({ staged: true }, ctx);
    assert.equal(staged.exitCode, 0, staged.stderr);
    assert.match(staged.stdout, /^\+export const a = 1;$/m, 'git.diff --staged shows the staged line');

    const commit = await new GitCommitTool().execute({ message: 'add a' }, ctx);
    assert.equal(commit.exitCode, 0, commit.stderr);
    const log = await new GitLogTool().execute({ n: 2 }, ctx);
    assert.equal(log.exitCode, 0, log.stderr);
    assert.match(log.stdout, /^[0-9a-f]+ add a\n[0-9a-f]+ initial\n$/, 'git.log shows the new commit on top');

    await writeFile(path.join(repo, 'a.ts'), 'export const a = 2;\n', 'utf8');
    const unstaged = await new GitDiffTool().execute({ paths: ['a.ts'] }, ctx);
    assert.equal(unstaged.exitCode, 0, unstaged.stderr);
    assert.match(unstaged.stdout, /^\+export const a = 2;$/m, 'git.diff shows the unstaged line');

    const reset = await new GitResetTool().execute({ to: 'HEAD~1', hard: true }, ctx);
    assert.equal(reset.exitCode, 0, reset.stderr);
    assert.equal(must(repo, ['rev-parse', 'HEAD']).trim(), initial, 'git.reset moved HEAD back');
    assert.equal(existsSync(path.join(repo, 'a.ts')), false, '--hard removed the reset commit\'s file');

    assert.equal(existsSync(marker), false, `no hook ran; the marker says: ${existsSync(marker) ? await readFile(marker, 'utf8') : ''}`);

    // Control: plain git in the same repository runs them.
    await writeFile(path.join(repo, 'b.ts'), 'b\n', 'utf8');
    assert.equal(plain(repo, ['add', 'b.ts']).status, 0);
    assert.equal(plain(repo, ['commit', '-q', '-m', 'control']).status, 0);
    const ran = (await readFile(marker, 'utf8')).split('\n').filter(Boolean);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
      assert.ok(ran.includes(hook), `plain git runs ${hook}, or this test proves nothing (ran: ${ran.join(', ')})`);
    }
  });
}

// ── the hook core.hooksPath does not cover ───────────────────────────────────

test('a core.fsmonitor hook naming a working-tree script is not run by git.status, git.add, git.diff or git.commit', NEEDS_GIT, async (t) => {
  const { root, repo } = await fixture(t, { name: 'Alice', email: 'alice@example.com' });
  const marker = path.join(root, 'fsmonitor-ran');
  // The fsmonitor hook is chosen by core.fsmonitor, not core.hooksPath, and a relative one
  // resolves in the working tree. Exit 1 tells git to scan, so the tools still see the truth.
  await markerScript(path.join(repo, 'fsmonitor.sh'), marker, 1);
  must(repo, ['add', 'fsmonitor.sh']);
  must(repo, ['commit', '-q', '-m', 'fsmonitor']);
  must(repo, ['config', 'core.fsmonitor', './fsmonitor.sh']);
  const ctx = ctxIn(repo);

  await writeFile(path.join(repo, 'a.ts'), 'a\n', 'utf8');
  for (const r of [
    await new GitStatusTool().execute({}, ctx),
    await new GitAddTool().execute({ paths: ['a.ts'] }, ctx),
    await new GitDiffTool().execute({ staged: true }, ctx),
    await new GitCommitTool().execute({ message: 'add a' }, ctx),
  ]) assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(head(repo, '%s'), 'add a');
  assert.equal(existsSync(marker), false, 'the fsmonitor hook did not run');

  // Control.
  assert.equal(plain(repo, ['status', '--porcelain']).status, 0);
  assert.equal(existsSync(marker), true, 'plain git status runs the fsmonitor hook, or this test proves nothing');
});

// ── acceptance 1: the host's configuration ───────────────────────────────────

test('the host\'s global and system config and config exported through the environment are ignored: no hook, no signing, no external diff, no host identity', NEEDS_GIT, async (t) => {
  const { root, repo } = await fixture(t, null);
  const hostile = path.join(root, 'hostile');
  const marker = path.join(hostile, 'ran');
  await mkdir(path.join(hostile, 'hooks'), { recursive: true });
  await markerScript(path.join(hostile, 'hooks', 'pre-commit'), marker);
  await markerScript(path.join(hostile, 'fsmonitor'), marker, 1);
  await markerScript(path.join(hostile, 'gpg'), marker, 1);
  await markerScript(path.join(hostile, 'external-diff'), marker);
  await writeFile(path.join(hostile, 'global'), [
    '[core]', `\thooksPath = ${path.join(hostile, 'hooks')}`, `\tfsmonitor = ${path.join(hostile, 'fsmonitor')}`,
    '[commit]', '\tgpgsign = true',
    '[gpg]', `\tprogram = ${path.join(hostile, 'gpg')}`,
    '[user]', '\tname = host', '\temail = host@host.invalid', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(hostile, 'system'), `[diff]\n\texternal = ${path.join(hostile, 'external-diff')}\n`, 'utf8');
  await writeFile(path.join(hostile, 'config-env'), '[user]\n\tname = config-env\n', 'utf8');
  // One channel per variable, each caught on its own: a hook, gpg or the external diff leaves the
  // marker; an identity read from any of them shows in the commit's author.
  const hostEnv: Record<string, string> = {
    GIT_CONFIG_GLOBAL:     path.join(hostile, 'global'),
    GIT_CONFIG_SYSTEM:     path.join(hostile, 'system'),
    // `git config` alone reads this, so it would answer the identity lookup with a name the
    // commit itself then never sees.
    GIT_CONFIG:            path.join(hostile, 'config-env'),
    // What `git -c user.name=params` exports to its children, and the counted form.
    GIT_CONFIG_PARAMETERS: "'user.name'='params'",
    GIT_CONFIG_COUNT:      '1',
    GIT_CONFIG_KEY_0:      'user.email',
    GIT_CONFIG_VALUE_0:    'count@host.invalid',
  };
  const saved = Object.keys(hostEnv).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, hostEnv);
  try {
    const ctx = ctxIn(repo);
    await writeFile(path.join(repo, 'README.md'), '# changed\n', 'utf8');
    const diff = await new GitDiffTool().execute({}, ctx);
    assert.equal(diff.exitCode, 0, diff.stderr);
    assert.match(diff.stdout, /^\+# changed$/m, 'git.diff is git\'s own diff');
    for (const r of [
      await new GitStatusTool().execute({}, ctx),
      await new GitAddTool().execute({ paths: ['README.md'] }, ctx),
      await new GitCommitTool().execute({ message: 'agent commit' }, ctx),
      await new GitLogTool().execute({ n: 1 }, ctx),
    ]) assert.equal(r.exitCode, 0, r.stderr);

    assert.equal(head(repo, '%s|%an <%ae>|%cn <%ce>'), 'agent commit|maf <maf@maf.invalid>|maf <maf@maf.invalid>',
      'a repository with no identity of its own commits as maf, not as the host');
    assert.doesNotMatch(must(repo, ['cat-file', 'commit', 'HEAD']), /^gpgsig /m, 'the commit is not signed');
    assert.equal(existsSync(marker), false, `nothing of the host's ran; the marker says: ${existsSync(marker) ? await readFile(marker, 'utf8') : ''}`);

    // Control: the same environment breaks a plain commit. Without it, a git too old to honour
    // GIT_CONFIG_GLOBAL (< 2.32) would let the assertions above pass vacuously.
    await writeFile(path.join(repo, 'c.ts'), 'c\n', 'utf8');
    const env = { ...process.env };
    assert.equal(plain(repo, ['add', 'c.ts'], env).status, 0);
    assert.notEqual(plain(repo, ['commit', '-q', '-m', 'control'], env).status, 0, 'the hostile config breaks a plain commit');
    assert.equal(existsSync(marker), true, 'and runs its programs, or this test proves nothing');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── acceptance 1: identity and signing ───────────────────────────────────────

test('git.commit commits as the repository\'s identity, unsigned, even when the repository asks for signing', NEEDS_GIT, async (t) => {
  const { root, repo } = await fixture(t, { name: 'Alice', email: 'alice@example.com' });
  const marker = path.join(root, 'gpg-ran');
  await markerScript(path.join(root, 'gpg'), marker, 1);
  must(repo, ['config', 'commit.gpgsign', 'true']);
  must(repo, ['config', 'gpg.program', path.join(root, 'gpg')]);
  const ctx = ctxIn(repo);

  await writeFile(path.join(repo, 'a.ts'), 'a\n', 'utf8');
  assert.equal((await new GitAddTool().execute({ paths: ['a.ts'] }, ctx)).exitCode, 0);
  const commit = await new GitCommitTool().execute({ message: 'agent commit' }, ctx);
  assert.equal(commit.exitCode, 0, commit.stderr);
  assert.equal(head(repo, '%an <%ae>|%cn <%ce>'), 'Alice <alice@example.com>|Alice <alice@example.com>');
  assert.doesNotMatch(must(repo, ['cat-file', 'commit', 'HEAD']), /^gpgsig /m, 'the commit is not signed');
  assert.equal(existsSync(marker), false, 'gpg.program did not run');

  // Control: plain git honours the repository's signing config, and its gpg refuses.
  assert.notEqual(plain(repo, ['commit', '-q', '--allow-empty', '-m', 'control']).status, 0);
  assert.equal(existsSync(marker), true, 'plain git runs gpg.program, or this test proves nothing');
});

test('git.commit names maf only for the parts of the identity the repository leaves unset', NEEDS_GIT, async (t) => {
  const cases: Array<[string, { name?: string; email?: string } | null, string]> = [
    ['none',       null,                             'maf <maf@maf.invalid>'],
    ['email only', { email: 'carol@example.com' },   'maf <carol@example.com>'],
    ['name only',  { name: 'Carol' },                'Carol <maf@maf.invalid>'],
  ];
  for (const [what, identity, expected] of cases) {
    const { repo } = await fixture(t, identity);
    const ctx = ctxIn(repo);
    await writeFile(path.join(repo, 'a.ts'), 'a\n', 'utf8');
    assert.equal((await new GitAddTool().execute({ paths: ['a.ts'] }, ctx)).exitCode, 0, what);
    const commit = await new GitCommitTool().execute({ message: 'agent commit' }, ctx);
    assert.equal(commit.exitCode, 0, `${what}: ${commit.stderr}`);
    assert.equal(head(repo, '%an <%ae>|%cn <%ce>'), `${expected}|${expected}`, what);
    assert.equal(plain(repo, ['config', '--get-regexp', '^user\\.']).stdout.includes('maf'), false,
      `${what}: the fallback is passed per call, never written to the repository's config`);
  }
});
