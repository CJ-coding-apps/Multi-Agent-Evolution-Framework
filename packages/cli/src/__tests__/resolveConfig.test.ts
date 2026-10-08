import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dag, DagNode, LcmMode, NodeId } from '@maf/types';
import { DEFAULT_RETRY_POLICY, makeNodeId, makeRunId } from '@maf/types';
import { defineRoleName } from '@maf/roles';
import type { MafConfig, ResolvedMafConfig } from '../config/ConfigLoader.js';
import { DEFAULT_MAF_CONFIG, applyDagSettings, resolveConfig } from '../config/ConfigLoader.js';

// ORACLE: WP-2.5 acceptance 2 — precedence is command-line flag > `.maf/config.yaml` > built-in
// default, per key, including keys inside a section: a flag that sets one retry field must not
// discard the file's other retry fields.

const defaults = DEFAULT_MAF_CONFIG;

function resolve(flags: MafConfig, file: MafConfig): ResolvedMafConfig {
  return resolveConfig({ flags, file, defaults });
}

/** Each key under test: how a layer sets it, and how to read it back from the resolved config. */
interface KeyCase<T> {
  name:  string;
  set:   (v: T) => MafConfig;
  get:   (c: ResolvedMafConfig) => T | undefined;
  flag:  T;
  file:  T;
  dflt:  T | undefined;
}

function checkPrecedence<T>(k: KeyCase<T>): void {
  test(`precedence for ${k.name}: flag > file > default`, () => {
    assert.notDeepEqual(k.flag, k.file, 'the case must tell the layers apart');
    assert.deepEqual(k.get(resolve(k.set(k.flag), k.set(k.file))), k.flag, 'a flag beats the file');
    assert.deepEqual(k.get(resolve({}, k.set(k.file))), k.file, 'the file beats the default');
    assert.deepEqual(k.get(resolve(k.set(k.flag), {})), k.flag, 'a flag beats the default');
    assert.deepEqual(k.get(resolve({}, {})), k.dflt, 'the default stands when no layer sets the key');
  });
}

checkPrecedence<string>({
  name: 'adapter', set: (adapter) => ({ adapter }), get: (c) => c.adapter,
  flag: 'gemini', file: 'codex', dflt: 'claude',
});
checkPrecedence<string>({
  name: 'model', set: (model) => ({ model }), get: (c) => c.model,
  flag: 'from-flag', file: 'from-file', dflt: undefined,
});
checkPrecedence<boolean>({
  // `--no-worktree` is the only way a flag says anything about the worktree: false beats a file's true.
  name: 'worktree (flag false over file true)', set: (worktree) => ({ worktree }), get: (c) => c.worktree,
  flag: false, file: true, dflt: true,
});
checkPrecedence<boolean>({
  // false is a value, not "unset": a file's false is not overridden by the default true.
  name: 'worktree (file false over default true)', set: (worktree) => ({ worktree }), get: (c) => c.worktree,
  flag: true, file: false, dflt: true,
});
checkPrecedence<number>({
  name: 'dag.maxConcurrent', set: (maxConcurrent) => ({ dag: { maxConcurrent } }), get: (c) => c.dag.maxConcurrent,
  flag: 1, file: 8, dflt: 4,
});
checkPrecedence<number>({
  name: 'dag.retry.maxAttempts', set: (maxAttempts) => ({ dag: { retry: { maxAttempts } } }), get: (c) => c.dag.retry.maxAttempts,
  flag: 1, file: 5, dflt: DEFAULT_RETRY_POLICY.maxAttempts,
});
checkPrecedence<number>({
  name: 'dag.retry.backoffMs', set: (backoffMs) => ({ dag: { retry: { backoffMs } } }), get: (c) => c.dag.retry.backoffMs,
  flag: 0, file: 5000, dflt: DEFAULT_RETRY_POLICY.backoffMs,
});
checkPrecedence<number>({
  name: 'timeouts.planMs', set: (planMs) => ({ timeouts: { planMs } }), get: (c) => c.timeouts.planMs,
  flag: 30_000, file: 600_000, dflt: 120_000,
});
checkPrecedence<number>({
  name: 'timeouts.securityReviewMs', set: (securityReviewMs) => ({ timeouts: { securityReviewMs } }), get: (c) => c.timeouts.securityReviewMs,
  flag: 30_000, file: 600_000, dflt: 120_000,
});
checkPrecedence<LcmMode>({
  name: 'lcm.mode', set: (mode) => ({ lcm: { mode } }), get: (c) => c.lcm.mode,
  flag: 'Dolt', file: 'Upward', dflt: 'Upward',
});
checkPrecedence<number>({
  name: 'lcm.contextThreshold', set: (contextThreshold) => ({ lcm: { contextThreshold } }), get: (c) => c.lcm.contextThreshold,
  flag: 0.5, file: 0.9, dflt: 0.75,
});

test('the defaults are the values maf run hard-codes today, so a run without a config file is unchanged', () => {
  assert.deepEqual(DEFAULT_MAF_CONFIG, {
    adapter:  'claude',
    worktree: true,
    lcm:      { mode: 'Upward', contextThreshold: 0.75, freshTailCount: 64 },
    dag:      { maxConcurrent: 4, retry: { ...DEFAULT_RETRY_POLICY } },
    timeouts: { planMs: 120_000, securityReviewMs: 120_000 },
  });
});

test('layers merge per key inside a section, not per section', () => {
  const resolved = resolve(
    { dag: { retry: { maxAttempts: 1 } } },
    { dag: { maxConcurrent: 2, retry: { backoffMs: 50, maxAttempts: 9 } } },
  );
  assert.deepEqual(resolved.dag, {
    maxConcurrent: 2,
    retry: { maxAttempts: 1, backoffMs: 50, backoffFactor: DEFAULT_RETRY_POLICY.backoffFactor, jitterMs: DEFAULT_RETRY_POLICY.jitterMs },
  });
});

test('resolving does not modify any layer, and the result shares no object with the defaults', () => {
  const flags: MafConfig = { dag: { retry: { maxAttempts: 1 } } };
  const file: MafConfig = { lcm: { freshTailCount: 8 } };
  const snapshot = JSON.stringify([flags, file, DEFAULT_MAF_CONFIG]);
  const resolved = resolve(flags, file);
  resolved.dag.retry.maxAttempts = 42;
  resolved.lcm.freshTailCount = 42;
  assert.equal(JSON.stringify([flags, file, DEFAULT_MAF_CONFIG]), snapshot);
  assert.equal(resolve({}, {}).dag.retry.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts);
});

test('an invalid flag value is refused, naming the setting', () => {
  assert.throws(
    () => resolve({ dag: { maxConcurrent: 0 } }, {}),
    /command line[\s\S]*dag\.maxConcurrent must be a positive integer; found 0\./,
  );
  assert.throws(() => resolve({ timeouts: { planMs: Number.NaN } }, {}), /timeouts\.planMs/);
  // Beyond Node's timer range a timeout fires after 1 ms, so it is refused rather than honoured as "1 ms".
  assert.throws(() => resolve({}, { timeouts: { securityReviewMs: 2 ** 31 } }), /timeouts\.securityReviewMs/);
});

// ── applyDagSettings: where the `dag` section is read ─────────────────────────────────────

function plannedDag(): Dag {
  const ids: NodeId[] = [makeNodeId('n1'), makeNodeId('n2')];
  const nodes = new Map<NodeId, DagNode>(ids.map((id) => [id, {
    id, label: id, agentRole: defineRoleName('coder'), dependencies: [],
    // The planner hands every node this one shared object.
    retryPolicy: DEFAULT_RETRY_POLICY, timeoutMs: 300_000,
    inputs: {}, outputs: {}, metadata: {},
  }]));
  return {
    id: 'd', runId: makeRunId('r'), nodes, edges: [],
    config: { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY_POLICY, timeoutMs: 600_000, reviewGateNodeIds: [] },
  };
}

test('applyDagSettings sets the scheduler concurrency and every node retry policy', () => {
  const settings = resolve({}, { dag: { maxConcurrent: 1, retry: { maxAttempts: 3, jitterMs: 0 } } }).dag;
  const applied = applyDagSettings(plannedDag(), settings);
  assert.equal(applied.config.maxConcurrent, 1);
  assert.equal(applied.nodes.size, 2);
  for (const node of applied.nodes.values()) {
    assert.deepEqual(node.retryPolicy, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, jitterMs: 0 });
  }
});

test('applyDagSettings writes through to neither the planned DAG nor the shared default retry policy', () => {
  const before = JSON.stringify(DEFAULT_RETRY_POLICY);
  const dag = plannedDag();
  const applied = applyDagSettings(dag, resolve({}, { dag: { maxConcurrent: 2, retry: { maxAttempts: 7 } } }).dag);
  assert.equal(JSON.stringify(DEFAULT_RETRY_POLICY), before, 'the shared default is untouched');
  assert.equal(dag.config.maxConcurrent, 4);
  for (const node of dag.nodes.values()) assert.equal(node.retryPolicy, DEFAULT_RETRY_POLICY);
  const nodes = [...applied.nodes.values()];
  assert.notEqual(nodes[0]?.retryPolicy, nodes[1]?.retryPolicy, 'each node gets its own policy object');
});
