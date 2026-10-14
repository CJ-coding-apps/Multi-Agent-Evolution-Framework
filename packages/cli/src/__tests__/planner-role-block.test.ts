import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId, makeToolId } from '@maf/types';
import { RoleRegistry, DEFAULT_ROLE_SET, defineRoleName } from '@maf/roles';
import type { RoleSet } from '@maf/roles';
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

const READ_ONLY_GUIDANCE = 'goes to a read-only role';

/** Render a block for an arbitrary set through the same seam, with a plan that names `planRole`. */
async function renderRoleBlock(set: RoleSet, planRole: string): Promise<string> {
  const registry = RoleRegistry.fromSet(set, process.cwd());
  let systemPrompt = '';
  const planner = new RetrievalAugmentedPlanner({
    graph: noopGraph,
    lcm: noopLcm,
    injector: noopInjector,
    roles: registry,
    roleCatalog: registry.catalog(),
    generatePlan: async (sys) => {
      systemPrompt = sys;
      return `\`\`\`json\n{"nodes":[{"id":"n1","label":"code","agentRole":"${planRole}"}],"edges":[]}\n\`\`\``;
    },
  });
  await planner.plan({ title: 't', description: 'd', runId: makeRunId('r-custom'), sessionId: 's1' });
  return systemPrompt;
}

test('the role block tags a role by its tools and declaration, never its name (F3)', async () => {
  // The names are deliberately the reflection of the built-in set: a *reader* named `coder` (and the
  // default), a *writer* that declares `expectsChange` named `analyst`. If either tag were rendered
  // from the name — `coder` ⇒ "must change the tree", `analyst` ⇒ "read-only" — the two assertions
  // below invert, which is the regression they exist to catch. `writes` comes from the tools the
  // role holds; `expectsChange` from the role's own declaration; the block reads both, not `role`.
  const set: RoleSet = {
    version: 1,
    defaultRole: defineRoleName('coder'),
    roles: [
      {
        role:              defineRoleName('coder'),
        description:       'Reads the tree and answers a question.',
        systemPrompt:      'You answer questions by reading the code. You make no change.',
        allowedTools:      [makeToolId('fs.read'), makeToolId('grep')],   // read-level: a reader
        policyTag:         'coder',
      },
      {
        role:              defineRoleName('analyst'),
        description:       'Makes the change the task asks for.',
        systemPrompt:      'You write the change the task asks for.',
        allowedTools:      [makeToolId('fs.read'), makeToolId('fs.write')],   // holds a write tool
        policyTag:         'analyst',
        expectsChange:     true,
      },
    ],
  };

  const systemPrompt = await renderRoleBlock(set, 'coder');
  assert.match(systemPrompt, /^- coder \(default, read-only\): Reads the tree and answers a question\.$/m);
  assert.match(systemPrompt, /^- analyst \(must change the tree\): Makes the change the task asks for\.$/m);
});

test('the read-only guidance line is emitted only when the set has a read-only role (F9)', async () => {
  // A writers-only set is told to route a question nowhere if the line is emitted anyway: the
  // guidance would contradict the block right above it, which lists no read-only role to send it to.
  const writersOnly: RoleSet = {
    version: 1,
    defaultRole: defineRoleName('coder'),
    roles: [
      {
        role:          defineRoleName('coder'),
        description:   'Writes the change.',
        systemPrompt:  'You write the change.',
        allowedTools:  [makeToolId('fs.read'), makeToolId('fs.write')],
        policyTag:     'coder',
        expectsChange: true,
      },
      {
        role:         defineRoleName('tester'),
        description:  'Adds tests.',
        systemPrompt: 'You add tests.',
        allowedTools: [makeToolId('fs.read'), makeToolId('patch.apply')],
        policyTag:    'tester',
      },
    ],
  };

  const systemPrompt = await renderRoleBlock(writersOnly, 'coder');
  assert.ok(
    !systemPrompt.includes(READ_ONLY_GUIDANCE),
    'no read-only role in the set ⇒ no line pointing at one',
  );
  // The two lines that do not depend on a reader are still there — the absence is the reader's line,
  // not the whole guidance block.
  assert.ok(systemPrompt.includes('emit a tester node that depends on it'), 'the tester line stays');
  assert.ok(systemPrompt.includes('emit an explicit security node'), 'the security line stays');
});

// F10: the whole prompt as the model is shown it for the built-in role set, snapshotted. Every other
// test here reads one line out of the block; this one pins the base template, the block and the
// guidance together. The prompt the planner sends is a published surface — a reader of a plan can see
// it — so an edit to it should have to be made here too, rather than drift unnoticed.
const EXPECTED_DEFAULT_PLANNING_INSTRUCTIONS =
`
You are a planning agent. Respond with a JSON code block containing a DAG specification.
Each node's "description" field is the FULL instruction given to the agent for that step — be specific and detailed.

\`\`\`json
{
  "nodes": [
    {
      "id": "n1",
      "label": "short step name",
      "description": "Full detailed instruction for the agent: what to investigate, what to change, what files to look at, what the fix should accomplish.",
      "agentRole": "coder",
      "dependencies": [],
      "timeoutMs": 300000
    }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "kind": "control" }
  ]
}
\`\`\`

Rules:
- description must be self-contained — the agent sees ONLY that field, nothing else
- Each node is an independent agent task
- dependencies[] lists node IDs that must complete before this node runs
- Avoid patterns listed in past-failures
- For simple single-step tasks, use exactly one node


Available agent roles (use these in node.agentRole):
- coder (default, must change the tree): Writes and modifies production code.
- tester (may change the tree): Writes tests only; cannot modify production source.
- security (read-only): Read-only security audit; flags CWE/OWASP issues as JSON.
- reviewer (read-only): Read-only diff review; approve or reject with suggestions.
- analyst (read-only): Read-only. Answers a question about the code, investigates, reports. Makes no change.

Guidance:
- After any coder node that introduces new behavior, emit a tester node that depends on it.
- When a task touches authentication, parsing of user input, secrets, or external network calls, emit an explicit security node. (A lightweight automatic security scan also runs on every writer role's diff.)
- A task that asks a question, an investigation or a report — no change to the code — goes to a read-only role. A node whose role must change the tree fails if it does not.`;

test('the full planning prompt for the default role set is this, verbatim (F10)', async () => {
  const systemPrompt = await renderDefaultRoleBlock();
  assert.equal(systemPrompt, EXPECTED_DEFAULT_PLANNING_INSTRUCTIONS);
});
