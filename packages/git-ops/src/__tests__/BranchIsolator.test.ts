import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeRunId, makeTaskId } from '@maf/types';
import { BranchIsolator } from '../BranchIsolator.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

const RUN  = makeRunId('r1');
const TASK = makeTaskId('t1');

test('createBranch() branches from the base branch and checks it out', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const mainSha = await git(['rev-parse', 'main'], repo);
  const info = await iso.createBranch(RUN, TASK);

  assert.equal(info.name, 'maf/r1/t1');
  assert.equal(info.baseSha, mainSha);
  assert.equal(await iso.currentBranch(), 'maf/r1/t1');
});

test('createBranch() sanitizes and truncates the branch name to 80 chars', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const longTask = makeTaskId('x'.repeat(120) + ' unsafe!chars');
  const info = await iso.createBranch(makeRunId('r 1'), longTask);
  assert.ok(info.name.length <= 80, `name length ${info.name.length}`);
  assert.doesNotMatch(info.name, /[^a-zA-Z0-9/-]/);
});

test('createBranch() falls back to HEAD when the base branch does not exist', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const headSha = await git(['rev-parse', 'HEAD'], repo);
  const info = await iso.createBranch(RUN, TASK, 'no-such-branch');
  assert.equal(info.baseSha, headSha);
});

test('switchTo() changes the checked-out branch', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  await iso.createBranch(RUN, TASK);
  await iso.switchTo('main');
  assert.equal(await iso.currentBranch(), 'main');
});

test('mergeBranch() with --no-ff brings task-branch commits into main as a merge commit', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const info = await iso.createBranch(RUN, TASK);
  await commitFile(repo, 'feature.txt', 'done\n', 'task work');

  await iso.mergeBranch(info.name, 'main');
  assert.equal(await iso.currentBranch(), 'main');
  assert.equal(await readFile(path.join(repo, 'feature.txt'), 'utf8'), 'done\n');
  const lastMessage = await git(['log', '-1', '--pretty=%s'], repo);
  assert.match(lastMessage, new RegExp(`Merge ${info.name.replace(/[/\\]/g, '\\$&')}`));
});

test('mergeBranch() with squash stages the changes on main without committing', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const info = await iso.createBranch(RUN, TASK);
  await commitFile(repo, 'squashed.txt', 'sq\n', 'task work');

  await iso.mergeBranch(info.name, 'main', true);
  assert.equal(await iso.currentBranch(), 'main');
  // squash merge leaves the change staged, not committed
  const staged = await git(['diff', '--cached', '--name-only'], repo);
  assert.match(staged, /squashed\.txt/);
  const lastMessage = await git(['log', '-1', '--pretty=%s'], repo);
  assert.doesNotMatch(lastMessage, /Merge/);
});

test('deleteBranch() removes a merged branch; force deletes an unmerged one', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const iso = new BranchIsolator(repo);
  const info = await iso.createBranch(RUN, TASK);
  await commitFile(repo, 'w.txt', 'w\n', 'unmerged work');
  await iso.switchTo('main');

  // Non-force delete of an unmerged branch fails silently (caught) — branch survives
  await iso.deleteBranch(info.name);
  assert.notEqual(await git(['branch', '--list', info.name], repo), '');

  await iso.deleteBranch(info.name, true);
  assert.equal(await git(['branch', '--list', info.name], repo), '');
});
