import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeCommitHash } from '@maf/types';
import { RollbackManager } from '../RollbackManager.js';
import { makeRepo, commitFile, git } from './gitTestUtils.js';

test('checkpoint() records HEAD and rollbackToLast() restores it', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  await commitFile(repo, 'app.txt', 'v1\n', 'v1');
  const checkpointHash = await mgr.checkpoint();
  assert.equal(checkpointHash, await git(['rev-parse', 'HEAD'], repo));

  await commitFile(repo, 'app.txt', 'v2 broken\n', 'v2');
  assert.notEqual(await git(['rev-parse', 'HEAD'], repo), checkpointHash);

  const restored = await mgr.rollbackToLast();
  assert.equal(restored, checkpointHash);
  assert.equal(await git(['rev-parse', 'HEAD'], repo), checkpointHash);
  assert.equal(await readFile(path.join(repo, 'app.txt'), 'utf8'), 'v1\n');
});

test('rollbackToLast() on an empty stack returns undefined and leaves HEAD alone', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  const headBefore = await git(['rev-parse', 'HEAD'], repo);
  assert.equal(await mgr.rollbackToLast(), undefined);
  assert.equal(await git(['rev-parse', 'HEAD'], repo), headBefore);
});

test('rollbackTo() resets to a specific checkpoint and trims the stack past it', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  const cp1 = await mgr.checkpoint();
  await commitFile(repo, 'a.txt', 'a\n', 'add a');
  const cp2 = await mgr.checkpoint();
  await commitFile(repo, 'b.txt', 'b\n', 'add b');
  const cp3 = await mgr.checkpoint();
  assert.deepEqual(mgr.history(), [cp1, cp2, cp3]);

  await mgr.rollbackTo(cp2);
  assert.equal(await git(['rev-parse', 'HEAD'], repo), cp2);
  assert.deepEqual(mgr.history(), [cp1, cp2]);
});

test('peek() returns the newest checkpoint without popping', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  assert.equal(mgr.peek(), undefined);
  const cp = await mgr.checkpoint();
  assert.equal(mgr.peek(), cp);
  assert.equal(mgr.peek(), cp); // still there
  assert.deepEqual(mgr.history(), [cp]);
});

test('history() returns a copy — mutating it does not affect the stack', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  await mgr.checkpoint();
  const hist = mgr.history();
  hist.push(makeCommitHash('bogus'));
  assert.equal(mgr.history().length, 1);
});

test('currentHead() reports the repo HEAD', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const mgr = new RollbackManager(repo);
  const head = await mgr.currentHead();
  assert.equal(head, await git(['rev-parse', 'HEAD'], repo));
});
