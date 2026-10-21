import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeAgentId, makeRunId } from '@maf/types';
import { LcmEngine } from '@maf/lcm';
import { TranscriptLogger } from '../TranscriptLogger.js';
import type { TranscriptLoggerConfig } from '../TranscriptLogger.js';
import { CompressionAgent } from '../CompressionAgent.js';

// ORACLE: D-17 (WP-3.2). The logger this replaces passed transcript-entry ids to the LCM as if they
// were LCM message ids (`chunk.map(e => e.id) as never[]`), so compaction failed the FOREIGN KEY,
// the failure was swallowed with `.catch(() => undefined)`, and the entries were dropped from the
// in-memory transcript anyway. A run lost context and nothing said so. The logger must hand over the
// id the LCM assigned, compaction must summarize exactly the entries it removes, and a failed
// compaction must be reported and must leave the entries in place.

const RUN = makeRunId('run-transcript-test');

function engine(): LcmEngine {
  return new LcmEngine({
    dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
    summarize: async (messages) => ({ content: `summary of ${messages.length}`, tokensUsed: 5 }),
  });
}

async function withLogger(
  config: Partial<Omit<TranscriptLoggerConfig, 'logDir' | 'lcm'>>,
  body: (logger: TranscriptLogger, engine: LcmEngine, logDir: string) => Promise<void>,
  lcm = engine(),
): Promise<void> {
  const logDir = await mkdtemp(path.join(tmpdir(), 'maf-transcript-'));
  try {
    const logger = new TranscriptLogger(RUN, makeAgentId('agent-test'), {
      logDir, softThreshold: 1_000_000, chunkSize: 20, ...config, lcm,
    });
    await logger.init();
    await body(logger, lcm, logDir);
  } finally {
    await rm(logDir, { recursive: true, force: true });
    lcm.close();
  }
}

test('compaction summarizes the messages the LCM stored, and removes exactly those entries', async () => {
  await withLogger({ chunkSize: 2 }, async (logger, lcm) => {
    await logger.append('user', 'first message');
    await logger.append('assistant', 'second message');
    await logger.append('user', 'third message');

    assert.equal(logger.getEntries().length, 3);

    const summaryId = await logger.compactNow();
    assert.ok(summaryId, 'a summary was produced');

    // The summary covers the LCM rows that correspond to the first two entries — not the
    // transcript ids, which the LCM never held.
    const covered = await lcm.lcm_expand(summaryId);
    assert.deepEqual(covered.map((m) => m.content).sort(), ['first message', 'second message']);

    assert.deepEqual(
      logger.getEntries().map((e) => e.content),
      ['third message'],
      'the compacted entries are the ones removed; the newest is untouched',
    );
    assert.equal(logger.getTotalTokens(), Math.ceil('third message'.length / 4));
  });
});

test('the JSONL log keeps every entry after compaction', async () => {
  await withLogger({ chunkSize: 1 }, async (logger, _lcm, logDir) => {
    await logger.append('user', 'kept on disk one');
    await logger.append('user', 'kept on disk two');
    await logger.compactNow();
    await logger.append('user', 'kept on disk three');

    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(path.join(logDir, `${RUN}.jsonl`), 'utf8')).trim().split('\n');
    assert.deepEqual(
      lines.map((l) => (JSON.parse(l) as { content: string }).content),
      ['kept on disk one', 'kept on disk two', 'kept on disk three'],
      'compaction is a memory operation; the durable transcript is complete',
    );
  });
});

test('a failed background compaction is reported and keeps the context (no silent loss)', async () => {
  const failures: unknown[] = [];
  const failing = new LcmEngine({
    dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
    summarize: async () => { throw new Error('the model was unavailable'); },
  });
  const logDir = await mkdtemp(path.join(tmpdir(), 'maf-transcript-'));
  try {
    const logger = new TranscriptLogger(RUN, makeAgentId('agent-test'), {
      logDir, softThreshold: 0, chunkSize: 1, lcm: failing,
      onCompactionError: (err) => failures.push(err),
    });
    await logger.init();
    await logger.append('user', 'this must not be dropped');

    // softThreshold 0 fires a background pass from `append`; `compactNow` first drains it.
    await logger.compactNow().catch(() => undefined);

    assert.equal(failures.length, 1, 'the failure was reported, not swallowed');
    assert.match(String(failures[0]), /model was unavailable/);
    assert.deepEqual(
      logger.getEntries().map((e) => e.content),
      ['this must not be dropped'],
      'a failed compaction keeps the entries it could not summarize',
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
    failing.close();
  }
});

test('CompressionAgent.idle waits for the background pass it started', async () => {
  const e = engine();
  const seen: string[] = [];
  const agent = new CompressionAgent({
    lcm: e, chunkSize: 2, softThreshold: 0,
    onCompacted: () => seen.push('compacted'),
    onError: (err) => seen.push(`error: ${String(err)}`),
  });
  agent.ingest(
    { id: 't1', runId: RUN, agentId: makeAgentId('a'), role: 'user', content: 'one', tokens: 1, timestamp: new Date(), metadata: {} },
    await e.addMessage({ sessionId: 's', runId: RUN, role: 'user', content: 'one', tokens: 1 }),
  );
  agent.ingest(
    { id: 't2', runId: RUN, agentId: makeAgentId('a'), role: 'user', content: 'two', tokens: 1, timestamp: new Date(), metadata: {} },
    await e.addMessage({ sessionId: 's', runId: RUN, role: 'user', content: 'two', tokens: 1 }),
  );

  await agent.idle();
  assert.ok(seen.length >= 1, 'the background pass ran');
  assert.ok(seen.every((s) => s === 'compacted'), 'and reported compactions, not errors');
  assert.equal(agent.getPendingCount(), 0, 'idle leaves no work behind');
  e.close();
});
