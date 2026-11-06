import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { GraphAwareInjector } from '@maf/prompt-injector';
import { MemoryGraph } from '@maf/memory-graph';
import { makeRunId } from '@maf/types';
import type { MemorySubgraph } from '@maf/types';
import {
  FIXED_SUM, dirtyUserRepo, driveRun, lockFilePolicy, needsLcm, onePlannedNode, registryOf,
} from './runFixture.js';

// ORACLE (WP-3.9 round 2, G1). The task description is what the user typed and it goes into the
// memory graph as the `Run` node's `taskDescription`; the injector then recalls that node and
// prepends it to a *later* run's planner prompt. So a key typed once in a task description was
// replayed into a model prompt on the next run: the write side stored it raw, and the read side
// rendered every node string it found without masking. Both ends now mask. The second test is the
// read side alone: it hands the injector a node holding a raw key, as a node written before this
// fix — or by any future writer that forgets — would.

const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE'; // matches CREDENTIAL_PATTERNS' aws-access-key exactly
const FIRST = `deploy the helper with ${FAKE_KEY} for the release`;
const SECOND = 'deploy the helper again';

test('a key in a task description is masked into the graph and into the next run\'s planner prompt',
  needsLcm, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maf-memory-masking-'));
    try {
      const repo = await dirtyUserRepo(root);
      const policy = await lockFilePolicy(root);
      const headless = () => ({ stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'masking-key' } });

      const first = new ScriptedAdapter([
        onePlannedNode(FIRST),
        { prompt: FIRST, steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'fixed' },
      ]);
      const run1 = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--no-worktree', '--policy', policy],
        { adapters: registryOf(first), io: headless() });
      assert.equal(run1.error, undefined, `${run1.out}\n${run1.err}`);

      // The way in: what the run actually stored. Read back with a fresh handle, as a later run
      // does — the assertion is on the graph, not on what the injector would render from it.
      const graph = new MemoryGraph(path.join(repo, '.maf', 'memory.kuzu'));
      try {
        const sub = await graph.querySubgraph('deploy the helper release', 20);
        const runNode = sub.nodes.find((n) => n.kind === 'Run');
        assert.ok(runNode, `the run recorded its Run node (kinds: ${sub.nodes.map((n) => n.kind).join(', ') || 'none'})`);
        const stored = String(runNode.properties['taskDescription']);
        assert.doesNotMatch(stored, new RegExp(FAKE_KEY), 'the graph holds the mask, not the key');
        assert.match(stored, /\[REDACTED:aws-access-key\]/);
      } finally {
        graph.close();
      }

      const second = new ScriptedAdapter([
        onePlannedNode(SECOND),
        { prompt: SECOND, steps: [{ tool: 'fs.write', input: { path: 'notes2.txt', content: 'second\n' } }], final: 'done' },
      ]);
      const run2 = await driveRun([SECOND, '--dir', repo, '--adapter', 'scripted', '--no-worktree', '--policy', policy],
        { adapters: registryOf(second), io: headless() });
      assert.equal(run2.error, undefined, `${run2.out}\n${run2.err}`);

      // The second run's planner prompt: the first exchange it answered, system prompt included.
      const planner = second.exchanges[0];
      assert.ok(planner, 'the second run asked its planner something');
      const prompt = planner.systemPrompt;
      assert.match(prompt, /<memory-graph>/, 'the first run\'s Run node was recalled, so the check is not vacuous');
      assert.doesNotMatch(prompt, new RegExp(FAKE_KEY), 'the key the user typed once is not in the next run\'s prompt');
      assert.match(prompt, /\[REDACTED:aws-access-key\]/, 'the mask is there, in its place');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('the injector masks node and ghost text on the way out, whoever wrote it', async () => {
  const subgraph: MemorySubgraph = {
    queryContext: 'deploy the helper',
    relevanceScores: new Map([['run-1', 1]]),
    edges: [],
    nodes: [{
      id: 'run-1', kind: 'Run', label: `deploy the helper with ${FAKE_KEY}`,
      properties: { taskDescription: `use ${FAKE_KEY} and api_key=abcdefghijklmnop`, adapter: 'claude' },
      runId: makeRunId('run-1'), createdAt: new Date(0), updatedAt: new Date(0),
    } as MemorySubgraph['nodes'][number]],
  };
  const graph = { querySubgraph: async () => subgraph } as unknown as MemoryGraph;
  const injector = new GraphAwareInjector({ graph, maxNodes: 40, tokenBudget: 4096 });
  const { systemPromptPrefix } = await injector.assemble('deploy the helper');

  assert.doesNotMatch(systemPromptPrefix, new RegExp(FAKE_KEY));
  assert.doesNotMatch(systemPromptPrefix, /abcdefghijklmnop/);
  assert.match(systemPromptPrefix, /label="deploy the helper with \[REDACTED:aws-access-key\]"/);
  assert.match(systemPromptPrefix, /taskDescription="use \[REDACTED:aws-access-key\] and \[REDACTED:generic-secret\]"/);
});
