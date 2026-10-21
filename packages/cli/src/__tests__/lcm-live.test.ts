import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LcmEngine, createAdapterSummarizer } from '@maf/lcm';
import type { AdapterName } from '@maf/types';
import { makeRunId } from '@maf/types';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';

// ORACLE: D-17 (WP-3.2) — with a real backend, a summary is produced by the run's own adapter,
// carries the backend's token count, and compaction covers exactly the messages it dropped.
//
// Opt-in: this test makes a real model call, so it does not run unless MAF_LIVE_SUMMARIZATION=1 is
// set and the adapter is installed. Wiring a scheduled job for it is WP-3.12; adding one here would
// change CI configuration, which this lane may not touch.

const LIVE = process.env.MAF_LIVE_SUMMARIZATION === '1';
const ADAPTER = (process.env.MAF_LIVE_ADAPTER ?? 'claude') as AdapterName;

test('a real adapter summarizes exactly the messages compaction drops', { skip: !LIVE }, async () => {
  const adapter = await resolveAdapter(ADAPTER, createAdapterRegistry());

  const engine = new LcmEngine({
    dbPath: ':memory:',
    contextThreshold: 0.5,
    freshTailCount: 1,
    mode: 'Upward',
    summarize: createAdapterSummarizer({ adapter, workingDir: process.cwd() }),
  });
  const runId = makeRunId('live-lcm');

  const contents = [
    'The deploy failed because the migration lock was held by a stale worker.',
    'We restarted the worker and the migration completed on the second attempt.',
    'The rollback plan is to restore the pre-migration snapshot if the second attempt fails.',
  ];
  for (const content of contents) {
    await engine.addMessage({ sessionId: 'live', runId, role: 'user', content, tokens: 14 });
  }

  // 42 raw tokens against a 60-token budget at 0.5: compaction runs and the oldest two are
  // summarized, while the tail (14) and the summary still fit under the ceiling.
  const ctx = await engine.assembleContext('live', 60);
  const summaries = ctx.summaries ?? [];
  assert.equal(summaries.length, 1, 'one summary was produced');
  assert.equal(summaries[0]!.operator, 'LLM-Map');
  assert.ok(summaries[0]!.content.trim().length > 0, 'the model returned a summary');
  assert.ok(summaries[0]!.tokens > 0, 'its cost is recorded from the call');

  const covered = await engine.lcm_expand(summaries[0]!.id);
  assert.deepEqual(
    covered.map((m) => m.content).sort(),
    contents.slice(0, 2).sort(),
    'the summary covers the two messages compaction dropped, and only those',
  );
  assert.deepEqual(ctx.messages.map((m) => m.content), [contents[2]], 'the fresh tail stayed raw');
  assert.ok(ctx.totalTokens <= 60, 'the budget stayed a ceiling');
  engine.close();
});
