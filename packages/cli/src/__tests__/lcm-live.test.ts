import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LcmEngine, createAdapterSummarizer } from '@maf/lcm';
import type { AdapterName } from '@maf/types';
import { makeRunId } from '@maf/types';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';

// ORACLE: D-17 (WP-3.2 F11) — with a real backend, a summary is produced by the run's own adapter,
// is *stored* in the archive, carries the backend's token count, and compaction covers exactly the
// messages it dropped.
//
// The budget is deliberately far larger than the transcript (4096 against ~50 tokens). A tiny
// budget would make the test pass even if the summary were never stored, because a context that
// drops the summary for lack of room looks the same as one that never made it. With room, every
// byte of the failure mode is visible: the summary must exist in `lcm_summaries`, be expandable by
// its id, and appear in the context.
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
    // A near-zero threshold is what forces compaction here; the *budget* is the one with room.
    contextThreshold: 0.001,
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

  // A 4096-token budget with ~50 raw tokens in the session: the summary has all the room it could
  // want, so its presence in the context is evidence it was stored, not that it was shoehorned in.
  const ctx = await engine.assembleContext('live', 4096);
  const summaries = ctx.summaries ?? [];
  assert.equal(summaries.length, 1, 'one summary was produced and fits with room to spare');
  assert.equal(summaries[0]!.operator, 'LLM-Map');
  assert.ok(summaries[0]!.content.trim().length > 0, 'the model returned a summary');
  assert.ok(summaries[0]!.tokens > 0, 'its cost is recorded from the call');
  assert.ok(ctx.totalTokens < 4096 / 2, 'the context is nowhere near the ceiling');

  // The summary is in the archive, reachable by the id the context carries — not a transient
  // string that happened to appear in one assembled prompt.
  const stored = await engine.expandSummary(summaries[0]!.id);
  assert.ok(stored, 'the summary is in lcm_summaries');
  assert.equal(stored.summary.id, summaries[0]!.id);
  assert.equal(stored.summary.level, 0);

  const covered = await engine.lcm_expand(summaries[0]!.id);
  assert.deepEqual(
    covered.map((m) => m.content).sort(),
    contents.slice(0, 2).sort(),
    'the summary covers the two messages compaction dropped, and only those',
  );
  assert.deepEqual(ctx.messages.map((m) => m.content), [contents[2]], 'the fresh tail stayed raw');
  assert.ok(ctx.totalTokens <= 4096, 'the budget stayed a ceiling');
  engine.close();
});
