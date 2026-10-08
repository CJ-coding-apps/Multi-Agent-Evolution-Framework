import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoFixture } from '../commands/inprocessDemo.js';

const execFileAsync = promisify(execFile);

/** Plain git, reading whatever global config the environment points at. */
function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', args, { cwd });
}

// ORACLE: audit P0 #6 (WP-1.9) — the demo's fixture commit used plain
// `execFileSync('git', …)`, so a user whose global config signs commits or points
// core.hooksPath at their own hooks could not run `maf inprocess-demo` at all, and anyone
// else had their hooks run against maf's throwaway repo.

test('the demo fixture commits under a global config that signs commits and runs a failing hook', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-demo-fixture-'));
  const hostile = path.join(root, 'hostile');
  const hooks = path.join(hostile, 'hooks');
  const marker = path.join(hostile, 'hook-ran');
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8');
  await chmod(path.join(hooks, 'pre-commit'), 0o755);
  await writeFile(
    path.join(hostile, 'gitconfig'),
    `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n`,
    'utf8',
  );

  const previous = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = path.join(hostile, 'gitconfig');
  try {
    const repo = await createDemoFixture(root);

    assert.equal(repo, path.join(root, 'repo'));
    const subject = (await git(repo, 'log', '-1', '--format=%s')).stdout.trim();
    assert.equal(subject, 'baseline (buggy sum)', 'the baseline commit must exist');
    const tracked = (await git(repo, 'ls-files')).stdout.trim().split('\n').sort();
    assert.deepEqual(tracked, ['config.txt', 'package.json', 'sum.js', 'test.js']);
    assert.equal((await git(repo, 'status', '--porcelain')).stdout, '', 'everything written must be committed');
    const commit = (await git(repo, 'cat-file', 'commit', 'HEAD')).stdout;
    assert.doesNotMatch(commit, /^gpgsig /m, 'the host commit.gpgsign must not reach the fixture');
    await assert.rejects(() => access(marker), 'the host pre-commit hook must never run');

    // Control: the same config does break a plain commit. Without this, a git too old to
    // honour GIT_CONFIG_GLOBAL (< 2.32) would let the assertions above pass vacuously.
    const control = path.join(root, 'control');
    await mkdir(control);
    await git(control, 'init', '-q');
    await writeFile(path.join(control, 'f.txt'), 'x', 'utf8');
    await git(control, 'add', '-A');
    await assert.rejects(
      () => git(control, '-c', 'user.email=control@maf.invalid', '-c', 'user.name=control',
        'commit', '-q', '-m', 'control'),
      'the hostile config must break a plain commit, or this test proves nothing',
    );
    await assert.doesNotReject(() => access(marker), 'the hostile hook must have run for the plain commit');
  } finally {
    if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
