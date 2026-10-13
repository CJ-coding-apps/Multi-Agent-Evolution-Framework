import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AttestationBundle, AttestorHandle, GraphQueryRunner, ToolCallRecord, ToolContext, ToolInput, ToolResult } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { InTotoStatement } from '@maf/attestation';
import { WorktreeManager, runIsolatedGit } from '@maf/git-ops';
import type { RunWorktree } from '@maf/git-ops';
import { PolicyEngine, PolicyViolationError } from '@maf/policy-engine';
import { executeToolGated } from '@maf/tool-loop';
import { createDefaultRegistry } from '@maf/tools';
import {
  BUGGY_SUM, FIXED_SUM, dirtyUserRepo, driveRun, needsLcm, onePlannedNode, registryOf, userState,
} from './runFixture.js';
import type { UserState } from './runFixture.js';

// ORACLE (F1 of the 0.3.0 release audit, replayed; round 2): a target with no `.maf/policy.yaml` — the
// documented default — and a user checkout with staged, unstaged and untracked work. The run's
// worktree comes from `WorktreeManager.createForRun`, and every call goes through the default tool
// registry and `executeToolGated`, as the in-process coder's calls do, with a policy engine that has
// no rules. The auditor's two attacks:
//
//  1. `fs.delete .git`, then `git.reset --hard`: git found no repository in the worktree, walked up
//     to the user's, and reset it — staged and unstaged work gone, index rewritten.
//  2. `fs.write .git` = `gitdir: <repo>/.git`, then `git.add` + `git.commit`: committed onto the
//     user's branch.
//
// After each, the user's index bytes, HEAD, branch, status and files are byte-identical. Each is
// replayed with MAF pointed at the repository's top and at a subdirectory of it, whose run works in
// `<worktree>/<sub>` — where the git tools must still work (round one's rule refused them there). A
// refused `.git` path is a `Deny` under `builtin:git-dir`: in the attestation, and not the end of the node.

const NO_RULES: GraphQueryRunner = { async run() { return []; } };
const GIT_DIR_RULE = 'builtin:git-dir';

class RecordingAttestor implements AttestorHandle {
  readonly records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

/**
 * `userState` without MAF's own directory wherever it sits: pointed at `pkg/`, the run keeps its state
 * — and its worktree — in `pkg/.maf/`, which `userState` leaves out only at the top.
 */
async function userCheckout(repo: string): Promise<UserState> {
  const state = await userState(repo);
  const outsideMaf = (p: string): boolean => !p.split(/[\\/]/).includes('.maf');
  return {
    ...state,
    files:  Object.fromEntries(Object.entries(state.files).filter(([p]) => outsideMaf(p))),
    status: state.status.filter((e) => outsideMaf(e.slice(3))),
  };
}

type At = 'top' | 'subdirectory';

/**
 * How the registry learns the repository: `production` is how `maf run` builds it today — before the
 * worktree exists, so the root is learned at the first git call — and `bound` is a registry built for
 * the run's root, which learns it at construction.
 */
type Registry = 'production' | 'bound';

interface Run {
  repo:     string;
  run:      RunWorktree;
  attestor: RecordingAttestor;
  call(tool: string, input: ToolInput): Promise<ToolResult>;
}

async function startRun(t: TestContext, at: At = 'top', registry: Registry = 'production'): Promise<Run> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-escape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = realpathSync(await dirtyUserRepo(root));
  if (at === 'subdirectory') {
    await mkdir(path.join(repo, 'pkg'));
    await writeFile(path.join(repo, 'pkg', 'sum.js'), BUGGY_SUM, 'utf8');
    await runIsolatedGit(repo, ['add', 'pkg/sum.js']);
    // Only that path, so the user's staged edit stays staged.
    await runIsolatedGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add pkg', '--', 'pkg/sum.js']);
  }
  const run = await new WorktreeManager(at === 'top' ? repo : path.join(repo, 'pkg')).createForRun(makeRunId('escape1'));
  const tools = registry === 'bound' ? createDefaultRegistry({ projectRoot: run.cwd }) : createDefaultRegistry();
  const policy = new PolicyEngine(NO_RULES);
  const attestor = new RecordingAttestor();
  const ctx: ToolContext = {
    cwd: run.cwd, projectRoot: run.cwd,
    runId: makeRunId('escape1'), taskId: makeTaskId('escape-task'), agentId: makeAgentId('inprocess-coder-escape'),
    sessionId: 'escape1', agentRole: 'coder', policy, attestor,
  };
  return {
    repo, run, attestor,
    async call(id, input) {
      const tool = tools.get(makeToolId(id));
      assert.ok(tool, `${id} is in the default registry`);
      return executeToolGated(tool, input, ctx, { policy, attestor });
    },
  };
}

/** The call is refused as a `Deny` under the built-in rule, and the refusal is the last record attested. */
async function assertGitDirDeny(r: Run, tool: string, input: ToolInput): Promise<void> {
  const before = r.attestor.records.length;
  await assert.rejects(() => r.call(tool, input), (err: unknown) => {
    assert.ok(err instanceof PolicyViolationError, `${tool} ${JSON.stringify(input)}: ${String(err)}`);
    assert.equal(err.decision.verdict, 'Deny');
    assert.equal(err.decision.verdict === 'Deny' ? err.decision.ruleId : undefined, GIT_DIR_RULE);
    assert.match(err.decision.reason, new RegExp(`^${tool.replace('.', '\\.')} refuses .*git's own data \\(\\.git\\)`));
    return true;
  });
  assert.equal(r.attestor.records.length, before + 1, `${tool}: the refusal is attested`);
  const record = r.attestor.records.at(-1);
  assert.equal(record?.toolId, tool);
  assert.equal(record?.policyDecision.verdict, 'Deny');
  assert.equal(record?.result.metadata['ruleId'], GIT_DIR_RULE);
  assert.equal(record?.result.metadata['refused'], true);
}

for (const at of ['top', 'subdirectory'] as const) {
  test(`F1 replay (${at}): fs.delete .git is a Deny under builtin:git-dir, and the worktree stays attached to its branch`, async (t) => {
    const r = await startRun(t, at);
    const before = await userCheckout(r.repo);
    const link = await readFile(path.join(r.run.path, '.git'), 'utf8');

    // `../.git` is the worktree's own link when the run works in its pkg/; refused by its spelling either way.
    for (const input of [{ path: '.git' }, { path: '.git', recursive: true }, { path: './.git' }, { path: '../.git' }]) {
      await assertGitDirDeny(r, 'fs.delete', input);
    }
    assert.equal(await readFile(path.join(r.run.path, '.git'), 'utf8'), link, 'the worktree\'s .git link is untouched');

    // The rest of the attack now has nothing to work with: the reset acts on the run's own branch.
    const reset = await r.call('git.reset', { to: 'HEAD', hard: true });
    assert.equal(reset.exitCode, 0, reset.stderr);
    assert.deepEqual(await userCheckout(r.repo), before, 'the user\'s checkout is byte-identical');
  });

  for (const when of ['before the first git call', 'after the first git call', 'with a registry built for the root'] as const) {
    test(`F1 replay (${at}): with .git removed by hand ${when}, git.reset --hard, git.add and git.commit are refused and the user's checkout is untouched`, async (t) => {
      const r = await startRun(t, at, when === 'with a registry built for the root' ? 'bound' : 'production');
      if (when === 'after the first git call') assert.equal((await r.call('git.status', {})).exitCode, 0);
      const before = await userCheckout(r.repo);
      // Removed outside the tools — by hand, or by `test.run`, which runs the project's own code.
      await rm(path.join(r.run.path, '.git'));
      // The control: git itself, run in the worktree now, works on the user's repository.
      const found = (await runIsolatedGit(r.run.cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
      assert.equal(realpathSync(found), r.repo, 'without the fix, every git tool would have acted on the user\'s checkout');

      const reset = await r.call('git.reset', { to: 'HEAD', hard: true });
      assert.equal(reset.exitCode, 1);
      assert.match(reset.stderr, /^refusing to run git: /);
      await r.call('fs.write', { path: 'sum.js', content: FIXED_SUM });
      for (const [tool, input] of [['git.add', { paths: ['sum.js'] }], ['git.commit', { message: 'agent commit on your branch' }]] as const) {
        const result = await r.call(tool, input);
        assert.equal(result.exitCode, 1, `${tool}: ${result.stdout}`);
        assert.match(result.stderr, /^refusing to run git: /, tool);
      }
      assert.deepEqual(await userCheckout(r.repo), before, 'the user\'s index bytes, HEAD, branch, status and files are as they were');
    });
  }

  test(`F1 replay (${at}): test.run deletes .git before the run's first git call; the git tools then refuse`, async (t) => {
    // The route an agent has without touching .git through the file tools: the project's own test
    // command, which test.run runs and which the agent can write. A registry built as `maf run` builds
    // it learns the root at its first git call, after the deletion — and refuses a root the repository
    // git then finds ignores, as the user's ignores `.maf/worktrees/`.
    const r = await startRun(t, at);
    const before = await userCheckout(r.repo);
    const gitLink = path.relative(r.run.cwd, path.join(r.run.path, '.git'));
    const script = `node -e "require('fs').rmSync(${JSON.stringify(gitLink).replace(/"/g, '\'')})"`;
    await r.call('fs.write', { path: 'package.json', content: JSON.stringify({ name: 'x', scripts: { test: script } }) });
    const ran = await r.call('test.run', { runner: 'npm' });
    assert.equal(ran.exitCode, 0, `${ran.stdout}${ran.stderr}`);
    await assert.rejects(readFile(path.join(r.run.path, '.git'), 'utf8'), 'the project\'s test command removed .git');

    for (const [tool, input] of [['git.reset', { to: 'HEAD', hard: true }], ['git.add', { paths: ['package.json'] }], ['git.commit', { message: 'agent commit on your branch' }]] as const) {
      const result = await r.call(tool, input);
      assert.equal(result.exitCode, 1, `${tool}: ${result.stdout}`);
      assert.match(result.stderr, /^refusing to run git: the repository git found around .* which ignores /, tool);
    }
    assert.deepEqual(await userCheckout(r.repo), before, 'the user\'s checkout is untouched');
  });

  test(`F1 replay (${at}): the gitdir rewrite is a Deny, so git.add and git.commit land on the run's branch, not the user's`, async (t) => {
    const r = await startRun(t, at);
    const before = await userCheckout(r.repo);
    const link = await readFile(path.join(r.run.path, '.git'), 'utf8');

    await assertGitDirDeny(r, 'fs.write', { path: '.git', content: `gitdir: ${path.join(r.repo, '.git')}\n` });
    if (at === 'subdirectory') await assertGitDirDeny(r, 'fs.write', { path: '../.git', content: `gitdir: ${path.join(r.repo, '.git')}\n` });
    assert.equal(await readFile(path.join(r.run.path, '.git'), 'utf8'), link);

    await r.call('fs.write', { path: 'sum.js', content: FIXED_SUM });
    assert.equal((await r.call('git.add', { paths: ['sum.js'] })).exitCode, 0);
    const commit = await r.call('git.commit', { message: 'agent commit on your branch' });
    assert.equal(commit.exitCode, 0, commit.stderr);

    const branchHead = (await runIsolatedGit(r.repo, ['log', '-1', '--format=%s', r.run.branch])).stdout.trim();
    assert.equal(branchHead, 'agent commit on your branch', 'the commit is on the run\'s branch');
    assert.deepEqual(await userCheckout(r.repo), before, 'and not on the user\'s');
  });
}

test('a run pointed at a subdirectory: git.status, git.add, git.diff and git.commit work, on the run\'s branch', async (t) => {
  for (const registry of ['production', 'bound'] as const) {
    const r = await startRun(t, 'subdirectory', registry);
    const before = await userCheckout(r.repo);
    assert.equal(r.run.cwd, path.join(r.run.path, 'pkg'), 'the run works in the worktree\'s pkg/');

    await r.call('fs.write', { path: 'sum.js', content: FIXED_SUM });
    const status = await r.call('git.status', {});
    assert.equal(status.exitCode, 0, `${registry}: ${status.stderr}`);
    assert.match(status.stdout, new RegExp(`^# branch\\.head ${r.run.branch}$`, 'm'));
    assert.match(status.stdout, /^1 \.M .*sum\.js$/m, 'the change in the subdirectory');
    const add = await r.call('git.add', { paths: ['sum.js'] });
    assert.equal(add.exitCode, 0, add.stderr);
    const diff = await r.call('git.diff', { staged: true });
    assert.equal(diff.exitCode, 0, diff.stderr);
    assert.match(diff.stdout, /^\+\+\+ b\/pkg\/sum\.js$/m);
    assert.match(diff.stdout, /^\+module\.exports = \(a, b\) => a \+ b;$/m);
    const commit = await r.call('git.commit', { message: 'fix sum in pkg' });
    assert.equal(commit.exitCode, 0, commit.stderr);

    assert.equal((await runIsolatedGit(r.repo, ['log', '-1', '--format=%s', r.run.branch])).stdout.trim(), 'fix sum in pkg');
    assert.equal((await runIsolatedGit(r.repo, ['show', `${r.run.branch}:pkg/sum.js`])).stdout, FIXED_SUM);
    assert.ok(r.attestor.records.every((c) => c.policyDecision.verdict === 'Allow' && c.result.exitCode === 0), registry);
    assert.deepEqual(await userCheckout(r.repo), before, `${registry}: the user's checkout is untouched`);
  }
});

// ── through `maf run` ─────────────────────────────────────────────────────────────────────────────

const TASK = 'Fix the bug in sum.js so the test passes';
const KEY = 'worktree-escape-signing-key';

test('maf run at a subdirectory: the refused fs.delete .git is in the signed bundle, and the node goes on to commit its fix with the git tools', needsLcm, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-escape-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = realpathSync(await dirtyUserRepo(root));
  await mkdir(path.join(repo, 'pkg'));
  await writeFile(path.join(repo, 'pkg', 'sum.js'), BUGGY_SUM, 'utf8');
  await runIsolatedGit(repo, ['add', 'pkg/sum.js']);
  await runIsolatedGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add pkg', '--', 'pkg/sum.js']);
  const before = await userCheckout(repo);
  const dir = path.join(repo, 'pkg');

  const scripted = new ScriptedAdapter([onePlannedNode(TASK), {
    prompt: TASK,
    steps: [
      { tool: 'fs.delete', input: { path: '.git', recursive: true } },
      { tool: 'git.status', input: {} },
      { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
      { tool: 'git.add', input: { paths: ['sum.js'] } },
      { tool: 'git.diff', input: { staged: true } },
      { tool: 'git.commit', input: { message: 'fix sum in pkg' } },
    ],
    final: 'Fixed pkg/sum.js and committed it.',
  }]);
  const run = await driveRun([TASK, '--dir', dir, '--adapter', 'scripted'], {
    adapters: registryOf(scripted),
    io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: KEY } },
  });
  assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
  const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
  assert.ok(runId, run.out);
  const branch = `maf/${runId}`;
  assert.ok(run.out.includes(`To take it: git merge ${branch}`), run.out);

  // The model was told why, and its next step ran.
  const told = scripted.exchanges.filter((e) => e.via === 'turn')[1]?.lastToolResult ?? '';
  assert.match(told, /^policy Deny: fs\.delete refuses "\.git": the path names git's own data \(\.git\)/);

  const statement = JSON.parse(await readFile(path.join(dir, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8')) as InTotoStatement<AttestationBundle>;
  const calls = statement.predicate.toolCalls.map((c) => ({
    tool: String(c.toolId), verdict: c.policyDecision.verdict, exit: c.result.exitCode, rule: c.result.metadata['ruleId'],
  }));
  assert.deepEqual(calls, [
    { tool: 'fs.delete',  verdict: 'Deny',  exit: 1, rule: GIT_DIR_RULE },
    { tool: 'git.status', verdict: 'Allow', exit: 0, rule: undefined },
    { tool: 'fs.write',   verdict: 'Allow', exit: 0, rule: undefined },
    { tool: 'git.add',    verdict: 'Allow', exit: 0, rule: undefined },
    { tool: 'git.diff',   verdict: 'Allow', exit: 0, rule: undefined },
    { tool: 'git.commit', verdict: 'Allow', exit: 0, rule: undefined },
  ], 'the refusal is in the bundle, and every git tool worked from the subdirectory');
  assert.equal(statement.predicate.outcome.status, 'Succeeded');

  assert.equal((await runIsolatedGit(repo, ['log', '-1', '--format=%s', branch])).stdout.trim(), 'fix sum in pkg');
  assert.equal((await runIsolatedGit(repo, ['show', `${branch}:pkg/sum.js`])).stdout, FIXED_SUM);
  assert.deepEqual(await userCheckout(repo), before, 'the user\'s checkout is byte-identical');
});
