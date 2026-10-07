import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import { DagRunner, DagParser } from '@maf/dag-runner';
import type { BlackboardValue, ToolId } from '@maf/types';
import { makeRunId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry, defineRoleName } from '@maf/roles';

// ORACLE: A3 / work order item 2 — the scheduler's
// isWriter predicate is driven by the ROLE CONFIG, and the direction that matters for
// throughput is the permissive one: two in-process roles whose every tool is read-level
// genuinely cannot touch the tree, so serializing them is concurrency thrown away.
// (The restrictive direction — a writer never runs beside another writer — is covered in
// @maf/dag-runner and @maf/roles.)

const RUN_ID = makeRunId('cli-concurrency');

const BASE_TOOLS = createDefaultRegistry();

// This helper *defines* the set the run uses, so the name is minted here — the same act a
// parsed roles.yaml performs. `twoIndependentNodes` is handed the registry, as `maf run` does.
const READER = defineRoleName('reader');

function rolesWith(execution: 'cli' | 'in-process', allowedTools: string[]): RoleRegistry {
  return RoleRegistry.fromSet({
    version: 1,
    defaultRole: READER,
    roles: [{ role: READER, systemPrompt: 'x', allowedTools: allowedTools as ToolId[], execution }],
  }, '/tmp/maf-cli-concurrency');
}

/** Two nodes with no dependency path between them — the shape a model actually emits. */
function twoIndependentNodes(roles: RoleRegistry) {
  return DagParser.fromSpec(
    { id: 'x', nodes: [{ id: 'n1', label: 'n1' }, { id: 'n2', label: 'n2' }] },
    RUN_ID,
    roles,
  );
}

/**
 * Runs the DAG exactly as `maf run` does — the predicate comes from the registry, not
 * from the test — and reports the highest number of nodes ever executing at once.
 */
async function peakConcurrency(roles: RoleRegistry): Promise<number> {
  let active = 0;
  let peak = 0;
  const executor = async (): Promise<Record<string, BlackboardValue>> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return {};
  };

  const outcome = await new DagRunner().run({
    dag: twoIndependentNodes(roles),
    board: new BlackboardStore(),
    executor,
    isWriter: (node) => roles.writesToWorkingTree(node.agentRole, BASE_TOOLS),
  });

  assert.equal(outcome.status, 'Succeeded');
  return peak;
}

test('two in-process reader nodes run concurrently', async () => {
  const roles = rolesWith('in-process', ['fs.read', 'fs.list', 'grep', 'git.diff']);
  assert.equal(await peakConcurrency(roles), 2,
    'a read-only in-process role cannot touch the tree, so nothing needs serializing');
});

test('the same two nodes are serialized the moment a write tool is allowed', async () => {
  // The contrast that keeps the test above from passing vacuously: same DAG, same
  // scheduler, one tool added to the allowlist.
  const roles = rolesWith('in-process', ['fs.read', 'fs.write']);
  assert.equal(await peakConcurrency(roles), 1);
});

test('a CLI-tier role is serialized even with a read-only allowlist', async () => {
  // The CLI agent brings its own file tools, so the allowlist is not the boundary.
  const roles = rolesWith('cli', ['fs.read', 'grep']);
  assert.equal(await peakConcurrency(roles), 1);
});
