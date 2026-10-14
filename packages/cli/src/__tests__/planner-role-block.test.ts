import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import { RoleRegistry, DEFAULT_ROLE_SET } from '@maf/roles';
import { RetrievalAugmentedPlanner } from '@maf/planning-agent';

// ORACLE (D-43, spec item 3). The planning-agent unit tests build a `roleCatalog` by hand, and
// planning-agent deliberately does not depend on @maf/roles — so neither of them ever renders the
// *default set* through the planner. This is the one place both the real `DEFAULT_ROLE_SET` and the
// planner are in scope, so it asserts the block the model is actually shown when a target has no
// roles file: the tag a plan routes on ("read-only" vs "must change the tree") is rendered from the
// role's own tools, and the default set's rendering cannot drift from the constant that is dispatched.

const noopGraph = { run: async () => [] } as never;
const noopLcm = { lcm_grep: async () => [] } as never;
const noopInjector = { assemble: async () => ({ systemPromptPrefix: '' }) } as never;

const PLAN = '```json\n{"nodes":[{"id":"n1","label":"code","agentRole":"coder"}],"edges":[]}\n```';

async function renderDefaultRoleBlock(): Promise<string> {
  const registry = RoleRegistry.fromSet(DEFAULT_ROLE_SET, process.cwd());
  let systemPrompt = '';
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    roles: registry,
    roleCatalog: registry.catalog(),
    generatePlan: async (sys) => { systemPrompt = sys; return PLAN; },
  });
  await planner.plan({ title: 't', description: 'd', runId: makeRunId('r1'), sessionId: 's1' });
  return systemPrompt;
}

test('the default role set, as the planner is shown it, tags each role by what it does to the tree', async () => {
  const systemPrompt = await renderDefaultRoleBlock();

  // The two facts a plan routes on, read from each role's own tools (never its name): the coder is
  // the default and must change the tree; the tester holds write tools but owes no change; the three
  // readers hold none.
  assert.match(systemPrompt, /^- coder \(default, must change the tree\): Writes and modifies production code\.$/m);
  assert.match(systemPrompt, /^- tester \(may change the tree\): Writes tests only; cannot modify production source\.$/m);
  assert.match(systemPrompt, /^- security \(read-only\): Read-only security audit; flags CWE\/OWASP issues as JSON\.$/m);
  assert.match(systemPrompt, /^- reviewer \(read-only\): Read-only diff review; approve or reject with suggestions\.$/m);
  assert.match(systemPrompt, /^- analyst \(read-only\): Read-only\. Answers a question about the code, investigates, reports\. Makes no change\.$/m);

  // All five, in the default set's order, each exactly once — the block is the set, not a subset.
  // The role block ends at the blank line before "Guidance:"; count only within it.
  const afterHeader = systemPrompt.split('Available agent roles (use these in node.agentRole):\n')[1] ?? '';
  const block = afterHeader.split('\n\n')[0] ?? '';
  const rows = block.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(rows.length, 5, `the block lists every default role:\n${block}`);
  assert.deepEqual(
    rows.map((l) => l.split(' ')[1]),
    ['coder', 'tester', 'security', 'reviewer', 'analyst'],
    'in the default set\'s order',
  );
});

test('the default-set block carries the spec\'s guidance line verbatim', async () => {
  const systemPrompt = await renderDefaultRoleBlock();
  assert.ok(
    systemPrompt.includes(
      '- A task that asks a question, an investigation or a report — no change to the code — goes ' +
      'to a read-only role. A node whose role must change the tree fails if it does not.',
    ),
    'the guidance line is present verbatim in the default-set prompt',
  );
});
