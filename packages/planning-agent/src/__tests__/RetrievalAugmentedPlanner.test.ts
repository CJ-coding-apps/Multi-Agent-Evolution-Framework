import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import { RetrievalAugmentedPlanner } from '../RetrievalAugmentedPlanner.js';

// Stubs for graph/lcm/injector — none are invoked when generatePlan returns a
// JSON DAG that already covers nodes/edges (no past-failure lookups in unit scope).
const noopGraph = { query: async () => [] } as never;
const noopLcm = { lcm_grep: async () => [] } as never;
const noopInjector = { assemble: async () => ({ systemPromptPrefix: '' }) } as never;

const PLAN_JSON = (role: string) => `\`\`\`json
{
  "nodes": [
    { "id": "n1", "label": "code", "agentRole": "${role}" }
  ],
  "edges": []
}
\`\`\``;

test('parsePlan preserves a valid agentRole from the LLM output', async () => {
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    defaultRole: 'coder',
    validRoles: new Set(['coder', 'tester']),
    generatePlan: async () => PLAN_JSON('tester'),
  });

  const dag = await planner.plan({
    title: 't', description: 'd',
    runId: makeRunId('r1'), sessionId: 's1',
  });
  const node = [...dag.nodes.values()][0]!;
  assert.equal(node.agentRole, 'tester');
});

test('parsePlan falls back to defaultRole when role is unknown', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const planner = new RetrievalAugmentedPlanner({
      graph: noopGraph,
      lcm: noopLcm,
      injector: noopInjector,
      defaultRole: 'coder',
      validRoles: new Set(['coder', 'tester']),
      generatePlan: async () => PLAN_JSON('ninja'),
    });

    const dag = await planner.plan({
      title: 't', description: 'd',
      runId: makeRunId('r1'), sessionId: 's1',
    });
    const node = [...dag.nodes.values()][0]!;
    assert.equal(node.agentRole, 'coder');
    assert.ok(warnings.some((w) => w.includes('ninja')), 'expected warning about unknown role');
  } finally {
    console.warn = originalWarn;
  }
});

test('parsePlan defaults agentRole when LLM omits it', async () => {
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    defaultRole: 'coder',
    validRoles: new Set(['coder']),
    generatePlan: async () => `\`\`\`json
{ "nodes": [{ "id": "n1", "label": "x" }], "edges": [] }
\`\`\``,
  });
  const dag = await planner.plan({
    title: 't', description: 'd',
    runId: makeRunId('r1'), sessionId: 's1',
  });
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'coder');
});

test('parsePlan falls back to single-node DAG when plan text is not JSON', async () => {
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    defaultRole: 'coder',
    validRoles: new Set(['coder']),
    generatePlan: async () => 'no json here, just a plain answer',
  });
  const dag = await planner.plan({
    title: 'do the thing', description: 'desc',
    runId: makeRunId('r1'), sessionId: 's1',
  });
  assert.equal(dag.nodes.size, 1);
  assert.equal([...dag.nodes.values()][0]?.agentRole, 'coder');
});

test('roleCatalog flows into planning instructions', async () => {
  let capturedSystemPrompt = '';
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    defaultRole: 'coder',
    roleCatalog: [
      { role: 'coder', description: 'writes code' },
      { role: 'tester', description: 'writes tests' },
    ],
    validRoles: new Set(['coder', 'tester']),
    generatePlan: async (sys) => {
      capturedSystemPrompt = sys;
      return PLAN_JSON('coder');
    },
  });
  await planner.plan({
    title: 't', description: 'd',
    runId: makeRunId('r1'), sessionId: 's1',
  });
  assert.match(capturedSystemPrompt, /Available agent roles/);
  assert.match(capturedSystemPrompt, /writes tests/);
});
