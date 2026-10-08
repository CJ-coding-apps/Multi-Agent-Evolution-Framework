import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoldenRunner } from '@maf/eval-harness';
import type { GoldenTask } from '@maf/eval-harness';
import { smokeCheck } from '../commands/evolve.js';

// ORACLE: v0.2.0 audit P2 "`runSmoke` checks `tasks[0]`" (evolve.ts) — the smoke check ran the
// whole corpus and judged its first task, so a candidate passed or failed on a task nobody named.

const task = (id: string): GoldenTask => ({
  id, repoFixture: 'fixtures/f', prompt: `do ${id}`, role: 'coder',
  verifiers: [{ kind: 'diff-match', mustContain: [], mustNotContain: [] }],
  provenance: { source: 'human-decision', ref: 'smoke test' },
});

test('the smoke check runs and judges the task it names, not the corpus\'s first', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-smoke-'));
  try {
    await mkdir(path.join(root, 'fixtures/f'), { recursive: true });
    await writeFile(path.join(root, 'fixtures/f/a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'corpus.json'), JSON.stringify([task('broken-first'), task('target')]), 'utf8');
    const ran: string[] = [];
    const runner = new GoldenRunner({
      corpusRoot: root, harnessSha: 'a'.repeat(64), harnessId: 'h', adapter: 'stub', attempts: 1,
      dispatch: async (t) => {
        ran.push(t.id);
        if (t.id === 'broken-first') throw new Error('the first task is broken');
        return 'ok';
      },
    });

    await smokeCheck(runner, 'target');
    assert.deepEqual(ran, ['target'], 'only the named task runs');
    await assert.rejects(() => smokeCheck(runner, 'broken-first'), /the first task is broken/);
    await assert.rejects(() => smokeCheck(runner, 'missing'), /not in the corpus/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
