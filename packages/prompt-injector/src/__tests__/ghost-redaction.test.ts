import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LcmContext, MemorySubgraph } from '@maf/types';
import { makeLcmSummaryId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import type { LcmEngine } from '@maf/lcm';
import { GraphAwareInjector } from '../GraphAwareInjector.js';

// ORACLE (WP-3.9 H5, G1): every string this file renders reaches a model, and a ghost cue is built
// from summary content — which is built from messages an agent wrote. The cue is masked where it is
// rendered, not only where it is made, because the archive holds writes from before the mask
// existed. The mutant that drops `redactText` from `formatGhosts` left the whole suite green: the
// node test covers `formatNode`, the cue test covered escaping only.
//
// This is a separate file from #52's `injector.test.ts` so the two branches do not add the same
// path (the merge keeps both).

const KEY = 'AKIAIOSFODNN7EXAMPLE';

/** A graph with no nodes: the cue is the only thing this assembly renders. */
const EMPTY_GRAPH = {
  querySubgraph: async (): Promise<MemorySubgraph> =>
    ({ nodes: [], edges: [], queryContext: 'task', relevanceScores: new Map() }),
} as unknown as MemoryGraph;

function injector(lcm: LcmEngine): GraphAwareInjector {
  return new GraphAwareInjector({ graph: EMPTY_GRAPH, lcm, maxNodes: 40, tokenBudget: 4_000 });
}

const lcmReturning = (context: Partial<LcmContext>): LcmEngine => ({
  assembleContext: async (): Promise<LcmContext> =>
    ({ messages: [], ghosts: [], totalTokens: 0, ...context }),
} as unknown as LcmEngine);

test('a ghost cue is masked where it is rendered, whatever wrote it (WP-3.9 H5, G1)', async () => {
  const lcm = lcmReturning({
    ghosts: [
      { summaryId: makeLcmSummaryId('s1'), cueText: `we used ${KEY} to sign the request`, relevance: 0.9 },
      { summaryId: makeLcmSummaryId('s2'), cueText: 'the retry loop was replaced', relevance: 0.5 },
    ],
  });

  const { systemPromptPrefix } = await injector(lcm).assemble('a task', 'session-1', 'coder');

  assert.doesNotMatch(systemPromptPrefix, new RegExp(KEY), 'no credential from a cue reaches the prompt');
  assert.match(systemPromptPrefix, /\[REDACTED:aws-access-key\]/, 'the cue is masked, not dropped');
  // Non-vacuity: the block was rendered, and a cue with nothing to mask is untouched.
  assert.match(systemPromptPrefix, /<ghost-cues>/);
  assert.match(systemPromptPrefix, /the retry loop was replaced/);
});
