import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import { RetrievalAugmentedPlanner } from '../RetrievalAugmentedPlanner.js';
import { rolesOf } from './roleResolver.js';

// Stubs for graph/lcm/injector — none are invoked when generatePlan returns a
// JSON DAG that already covers nodes/edges (no past-failure lookups in unit scope).
const noopGraph = { run: async () => [] } as never;
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
    roles: rolesOf(['coder', 'tester']),
    generatePlan: async () => PLAN_JSON('tester'),
  });

  const dag = await planner.plan({
    title: 't', description: 'd',
    runId: makeRunId('r1'), sessionId: 's1',
  });
  const node = [...dag.nodes.values()][0]!;
  assert.equal(node.agentRole, 'tester');
});

test('an unknown agentRole rejects the plan instead of widening privilege', async () => {
  // This test replaces one that locked the old behaviour ("falls back to defaultRole when role
  // is unknown", asserting the node came out as `coder`). The fallback *was* the escalation:
  // the default role is the writer, so a hallucinated name silently gained `fs.write`,
  // `git.commit` and `patch.apply`. The guarantee now is refusal, with the real names listed.
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    roles: rolesOf(['coder', 'tester']),
    generatePlan: async () => PLAN_JSON('ninja'),
  });

  // Refused rather than re-planned: a spec that parsed and named a bad role must not be
  // swallowed into the single-node default DAG, which would dispatch a `coder`.
  await assert.rejects(
    () => planner.plan({ title: 't', description: 'd', runId: makeRunId('r1'), sessionId: 's1' }),
    (e: Error) => {
      assert.match(e.message, /unknown agentRole "ninja"/);
      assert.match(e.message, /coder, tester/);
      return true;
    },
  );
});

test('parsePlan defaults agentRole when LLM omits it', async () => {
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    roles: rolesOf(['coder']),
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
    roles: rolesOf(['coder']),
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
    roles: rolesOf(['coder', 'tester']),
    roleCatalog: [
      { role: 'coder', description: 'writes code', writes: true, expectsChange: true },
      { role: 'tester', description: 'writes tests', writes: true, expectsChange: false },
    ],
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

// D-43: the role block states what each role does to the tree, taken from the two booleans the
// caller supplies and never from the role's name. A plan routes a question to a read-only role
// because the block says "read-only", not because the name happens to be `analyst`.
test('the role block tags each role by what it does to the tree, from writes/expectsChange', async () => {
  let capturedSystemPrompt = '';
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    roles: rolesOf(['coder', 'analyst', 'reviewer']),
    roleCatalog: [
      { role: 'coder',    description: 'changes the tree', writes: true,  expectsChange: true  },
      { role: 'analyst',  description: 'answers questions', writes: false, expectsChange: false },
      { role: 'reviewer', description: 'reviews diffs',     writes: false, expectsChange: false },
    ],
    generatePlan: async (sys) => { capturedSystemPrompt = sys; return PLAN_JSON('coder'); },
  });
  await planner.plan({ title: 't', description: 'd', runId: makeRunId('r1'), sessionId: 's1' });
  assert.match(capturedSystemPrompt, /^- coder \(default, must change the tree\): changes the tree$/m);
  assert.match(capturedSystemPrompt, /^- analyst \(read-only\): answers questions$/m);
  assert.match(capturedSystemPrompt, /^- reviewer \(read-only\): reviews diffs$/m);
  // The tag comes from the fields, not the name: a `tester`-named role that holds a write tool but
  // owes no change renders "may change the tree", proving the name is not consulted.
  let second = '';
  const planner2 = new RetrievalAugmentedPlanner({
    graph: noopGraph, lcm: noopLcm, injector: noopInjector,
    roles: rolesOf(['coder', 'tester']),
    roleCatalog: [{ role: 'tester', description: 'writes tests', writes: true, expectsChange: false }],
    generatePlan: async (sys) => { second = sys; return PLAN_JSON('coder'); },
  });
  await planner2.plan({ title: 't', description: 'd', runId: makeRunId('r2'), sessionId: 's1' });
  assert.match(second, /^- tester \(may change the tree\): writes tests$/m);
});

test('the guidance tells the planner where a question goes and that a writer must change the tree', async () => {
  let capturedSystemPrompt = '';
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph, lcm: noopLcm, injector: noopInjector,
    roles: rolesOf(['coder']),
    roleCatalog: [{ role: 'coder', description: 'changes the tree', writes: true, expectsChange: true }],
    generatePlan: async (sys) => { capturedSystemPrompt = sys; return PLAN_JSON('coder'); },
  });
  await planner.plan({ title: 't', description: 'd', runId: makeRunId('r3'), sessionId: 's1' });
  assert.ok(
    capturedSystemPrompt.includes(
      '- A task that asks a question, an investigation or a report — no change to the code — goes ' +
      'to a read-only role. A node whose role must change the tree fails if it does not.',
    ),
    'the guidance line is present verbatim',
  );
});
