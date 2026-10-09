import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolInput, ToolPlugin, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { FsWriteTool, FsDeleteTool } from '../plugins/fs.js';
import { PatchApplyTool } from '../plugins/patch.js';
import {
  GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool,
} from '../plugins/git.js';
import type { GitExec } from '../plugins/git.js';

// ORACLE (F1 of the 0.3.0 release audit): the agent's tools cannot leave the run's worktree for the
// user's checkout. The auditor did it with two built-in calls and no policy file: `fs.delete .git`,
// then `git.reset --hard`, which git — finding no repository in the worktree — ran on the user's
// checkout above it; and `fs.write .git` = `gitdir: <repo>/.git`, then `git.add` + `git.commit`,
// which committed onto the user's branch. Two built-in layers close it, neither of them a rule:
//
//  - fs.write, fs.delete and patch.apply refuse a path naming `.git` from `declaredPaths`, which the
//    gate evaluates before policy, and again on the resolved path when they run;
//  - every git tool asks git which working tree it found, before every call, and refuses unless it is
//    the project root; discovery is capped at the root's parent, so a tree without `.git` is no repository.
//
// The same attack through `WorktreeManager.createForRun` and the real registry is in
// `cli/worktree-escape.test.ts`.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

function ctxIn(root: string, cwd = root): ToolContext {
  return {
    cwd,
    projectRoot: root,
    runId:       makeRunId('r-worktree-confinement'),
    taskId:      makeTaskId('t-worktree-confinement'),
    agentId:     makeAgentId('a-worktree-confinement'),
    sessionId:   's-worktree-confinement',
    policy:      ALLOW,
    attestor:    NO_ATTESTOR,
  };
}

const NEEDS_GIT = { skip: spawnSync('git', ['--version']).error === undefined ? false : 'git is not on PATH' };

async function tmp(t: TestContext, prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * No GIT_* from this process and no host config: fixtures are shaped by the case alone. No optional
 * locks, so reading the user's status never rewrites the index whose bytes a case compares.
 */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}

function plain(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, env: plainEnv(), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function must(cwd: string, args: string[]): string {
  const r = plain(cwd, args);
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const GIT_DIR_REFUSAL = /refuses .*git's own data \(\.git\)/;

// ── fs.write, fs.delete, patch.apply: `.git` is refused before policy ────────────────────────────

/** Spellings of a path into git's data; each must be refused whatever the policy would say. */
const GIT_DIR_SPELLINGS = ['.git', './.git', '.git/', '.git/config', '.git/hooks/pre-commit', 'sub/../.git', 'vendor/lib/.git/HEAD', '.GIT', '.Git/index'];
/** Neighbours that are not git's data, and must stay writable. */
const NOT_GIT_DIR = ['.gitignore', '.gitattributes', '.github/workflows/ci.yml', 'docs/.git-notes', 'src/git/index.ts'];

function diffTouching(p: string): string {
  return `--- a/${p}\n+++ b/${p}\n@@ -0,0 +1 @@\n+x\n`;
}

test('fs.write, fs.delete and patch.apply refuse every spelling of a .git path when they declare it — before policy', () => {
  const declares: Array<[string, (p: string) => string[]]> = [
    ['fs.write',    (p) => new FsWriteTool().declaredPaths({ path: p, content: 'gitdir: /elsewhere/.git\n' })],
    ['fs.delete',   (p) => new FsDeleteTool().declaredPaths({ path: p, recursive: true })],
    ['patch.apply', (p) => new PatchApplyTool().declaredPaths({ diff: diffTouching(p) })],
  ];
  for (const [tool, declare] of declares) {
    for (const p of GIT_DIR_SPELLINGS) {
      assert.throws(() => declare(p), (err: Error) => {
        assert.match(err.message, GIT_DIR_REFUSAL, `${tool} ${p}`);
        assert.ok(err.message.startsWith(`${tool} refuses `), `${tool} ${p}: the refusal names the tool`);
        return true;
      }, `${tool} ${p}`);
    }
    for (const p of NOT_GIT_DIR) assert.deepEqual(declare(p), [p], `${tool} ${p} is not git's data`);
  }
});

test('a direct execute refuses the same paths: the gitdir rewrite and the delete leave .git as it was', async (t) => {
  const root = await tmp(t, 'maf-gitdir-exec-');
  const gitFile = path.join(root, '.git');
  await writeFile(gitFile, 'gitdir: /somewhere/.git/worktrees/run\n', 'utf8');

  await assert.rejects(
    () => new FsWriteTool().execute({ path: '.git', content: 'gitdir: /home/user/repo/.git\n' }, ctxIn(root)),
    GIT_DIR_REFUSAL,
  );
  await assert.rejects(() => new FsDeleteTool().execute({ path: '.git' }, ctxIn(root)), GIT_DIR_REFUSAL);
  await assert.rejects(() => new FsDeleteTool().execute({ path: './.GIT', recursive: true }, ctxIn(root)), GIT_DIR_REFUSAL);
  assert.equal(await readFile(gitFile, 'utf8'), 'gitdir: /somewhere/.git/worktrees/run\n', '.git is unchanged');

  // The control: an ordinary dotfile beside it is written as before.
  await new FsWriteTool().execute({ path: '.gitignore', content: 'dist/\n' }, ctxIn(root));
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), 'dist/\n');
});

test('a link inside the root that leads into .git is refused on its resolved path', async (t) => {
  const root = await tmp(t, 'maf-gitdir-link-');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  await symlink(path.join(root, '.git'), path.join(root, 'innocent'));

  await assert.rejects(
    () => new FsWriteTool().execute({ path: 'innocent/config', content: '[core]\n\tfsmonitor = ./x\n' }, ctxIn(root)),
    /fs\.write refuses "innocent\/config": it resolves to "\.git\/config", which is git's own data/,
  );
  await assert.rejects(() => new FsDeleteTool().execute({ path: 'innocent', recursive: true }, ctxIn(root)), /it resolves to "\.git"/);
  await assert.rejects(
    () => new PatchApplyTool().execute({ diff: diffTouching('innocent/config') }, ctxIn(root)),
    /patch\.apply refuses "innocent\/config": it resolves to "\.git\/config"/,
  );
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), '[core]\n');
});

test('fs.delete refuses the project root itself, which holds .git', async (t) => {
  const root = await tmp(t, 'maf-gitdir-root-');
  await writeFile(path.join(root, '.git'), 'gitdir: /x\n', 'utf8');
  for (const p of ['.', '', './', 'sub/..']) {
    await assert.rejects(
      () => new FsDeleteTool().execute({ path: p, recursive: true }, ctxIn(root)),
      /fs\.delete refuses .*it is the project root, which holds git's own data/,
      JSON.stringify(p),
    );
  }
  assert.ok(existsSync(path.join(root, '.git')));
});

test('patch.apply refuses a diff into .git before it writes a temp file or runs patch', async (t) => {
  const root = await tmp(t, 'maf-gitdir-patch-');
  await mkdir(path.join(root, '.git'));
  const diff = `diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -0,0 +1 @@\n+[core]\n`;
  await assert.rejects(() => new PatchApplyTool().execute({ diff }, ctxIn(root)), GIT_DIR_REFUSAL);
  assert.ok(!existsSync(path.join(root, '.git', 'config')), 'nothing was written into .git');
});

// ── the git tools: only the run's own working tree ─────────────────────────────────────────────────

/** Every git tool, with an input it would otherwise run. */
function everyGitTool(exec?: GitExec): Array<[string, ToolPlugin, ToolInput]> {
  return [
    ['git.status', new GitStatusTool(exec), {}],
    ['git.diff',   new GitDiffTool(exec),   {}],
    ['git.add',    new GitAddTool(exec),    { paths: ['a.txt'] }],
    ['git.commit', new GitCommitTool(exec), { message: 'agent commit on your branch' }],
    ['git.log',    new GitLogTool(exec),    { n: 1 }],
    ['git.reset',  new GitResetTool(exec),  { to: 'HEAD', hard: true }],
  ];
}

test('a git tool refuses, and runs nothing, when the repository git finds is not the project root', async (t) => {
  const root = await tmp(t, 'maf-git-probe-');
  const elsewhere = path.dirname(root);
  for (const [name, , input] of everyGitTool()) {
    const ran: string[][] = [];
    const exec: GitExec = async (_file, args) => {
      ran.push(args);
      if (args.includes('rev-parse')) return { stdout: `${elsewhere}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = everyGitTool(exec).find(([n]) => n === name)?.[1];
    assert.ok(tool);
    const r = await tool.execute(input, ctxIn(root));
    assert.equal(r.exitCode, 1, name);
    assert.equal(r.stderr, `refusing to run git: the repository git found at ${elsewhere} is not the run's working tree ${root}.`, name);
    // git.commit asks twice (its identity lookup, then the commit); every call refused at the probe.
    assert.ok(ran.length > 0 && ran.every((a) => a.slice(-2).join(' ') === 'rev-parse --show-toplevel'), `${name}: only the probe ran`);
  }
});

test('a git tool refuses when git finds no repository at all', async (t) => {
  const root = await tmp(t, 'maf-git-probe-none-');
  const exec: GitExec = async (_file, args) => {
    if (args.includes('rev-parse')) throw Object.assign(new Error('exit 128'), { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
    throw new Error('git must not run past a failed probe');
  };
  const r = await new GitResetTool(exec).execute({ to: 'HEAD', hard: true }, ctxIn(root));
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, new RegExp(`^refusing to run git: git found no repository from ${root} inside the run's working tree ${root} \\(git said: fatal: not a git repository`));
});

/**
 * The user's repository with an inner checkout below it, as `.maf/worktrees/<id>` sits below the
 * user's checkout: `outer` has a commit and staged, unstaged and untracked work; `inner` is a git
 * worktree of it on its own branch.
 */
async function userRepoWithWorktree(t: TestContext): Promise<{ outer: string; inner: string }> {
  const outer = await tmp(t, 'maf-git-escape-');
  must(outer, ['init', '-q', '-b', 'main']);
  must(outer, ['config', 'user.name', 'User']);
  must(outer, ['config', 'user.email', 'user@example.com']);
  await writeFile(path.join(outer, 'a.txt'), 'committed\n', 'utf8');
  must(outer, ['add', 'a.txt']);
  must(outer, ['commit', '-q', '-m', 'base']);
  await writeFile(path.join(outer, '.gitignore'), '.maf/\n', 'utf8');
  must(outer, ['add', '.gitignore']);
  await writeFile(path.join(outer, 'a.txt'), 'committed\nstaged by the user\n', 'utf8');
  must(outer, ['add', 'a.txt']);
  await writeFile(path.join(outer, 'a.txt'), 'committed\nstaged by the user\nunstaged by the user\n', 'utf8');
  await writeFile(path.join(outer, 'notes.txt'), 'untracked\n', 'utf8');
  const inner = path.join(outer, '.maf', 'worktrees', 'run1');
  must(outer, ['worktree', 'add', '-q', '-b', 'maf/run1', inner, 'HEAD']);
  return { outer, inner };
}

async function snapshot(repo: string): Promise<{ index: string; head: string; status: string; files: string }> {
  return {
    index:  (await readFile(path.join(repo, '.git', 'index'))).toString('base64'),
    head:   must(repo, ['rev-parse', 'HEAD']) + must(repo, ['symbolic-ref', 'HEAD']),
    status: must(repo, ['-c', 'core.fsmonitor=', 'status', '--porcelain=v1', '--untracked-files=all']),
    files:  (await readFile(path.join(repo, 'a.txt'), 'utf8')) + (await readFile(path.join(repo, 'notes.txt'), 'utf8')),
  };
}

test('with the worktree\'s .git gone, no git tool reaches the user\'s repository around it', NEEDS_GIT, async (t) => {
  const { outer, inner } = await userRepoWithWorktree(t);
  await rm(path.join(inner, '.git'));
  // The control: git itself, run there, now finds the user's repository — the auditor's reset --hard.
  assert.equal(realpathSync(must(inner, ['rev-parse', '--show-toplevel']).trim()), outer, 'plain git walks up to the user\'s checkout');
  const before = await snapshot(outer);

  for (const [name, tool, input] of everyGitTool()) {
    const r = await tool.execute(input, ctxIn(inner));
    assert.equal(r.exitCode, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /refusing to run git: git found no repository from .* inside the run's working tree/, name);
    assert.deepEqual(await snapshot(outer), before, `${name} left the user's index, HEAD, status and files as they were`);
  }
});

test('the git tools still work in an intact worktree, and in a subdirectory of the root', NEEDS_GIT, async (t) => {
  const { inner } = await userRepoWithWorktree(t);
  await mkdir(path.join(inner, 'sub'));
  const status = await new GitStatusTool().execute({}, ctxIn(inner, path.join(inner, 'sub')));
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /# branch\.head maf\/run1/);
  const log = await new GitLogTool().execute({ n: 1 }, ctxIn(inner));
  assert.equal(log.exitCode, 0, log.stderr);
  assert.match(log.stdout, /base/);
});

test('a nested repository between the cwd and the root is not the run\'s working tree', NEEDS_GIT, async (t) => {
  const { inner } = await userRepoWithWorktree(t);
  const nested = path.join(inner, 'vendor');
  await mkdir(nested);
  must(nested, ['init', '-q']);
  const r = await new GitStatusTool().execute({}, ctxIn(inner, nested));
  assert.equal(r.exitCode, 1);
  assert.equal(r.stderr, `refusing to run git: the repository git found at ${nested} is not the run's working tree ${inner}.`);
});
