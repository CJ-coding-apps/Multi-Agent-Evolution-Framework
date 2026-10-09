import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type {
  BlackboardValue, DagNode, FailureRecorder, NodeFailureRecord, RetryPolicy, RunOutcome,
} from '@maf/types';
import {
  DEFAULT_RETRY_POLICY, GateRefused, NodeFailure, TransportError, makeNodeId, makeRunId,
} from '@maf/types';
import { DagRunner, DagParser } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (D-16): the planner recalls past failures, and nothing ever wrote one down. The
// scheduler is where a node's verdict becomes final — after its retries are spent — so it is
// where the failure is handed to a recorder: once per failed node, never per attempt, and never
// for a node that succeeded. The recorder is memory, not judgment: if it throws, the node is
// still Failed for the reason it failed, and the run carries on.

const RUN_ID = makeRunId('failure-recorder');
const ROLES = testRoleResolver(['coder', 'tester'], 'coder');
const NO_WAIT: RetryPolicy = { ...DEFAULT_RETRY_POLICY, backoffMs: 0, jitterMs: 0 };

type NodeSpec = Parameters<typeof DagParser.fromSpec>[0]['nodes'];

function dagOf(nodes: NodeSpec) {
  return DagParser.fromSpec({ id: 'x', nodes }, RUN_ID, ROLES);
}

function capturing(): FailureRecorder & { records: NodeFailureRecord[] } {
  const records: NodeFailureRecord[] = [];
  return { records, recordFailure: async (input) => { records.push(input); } };
}

function nodeState(outcome: RunOutcome, id: string) {
  return outcome.nodes?.find((n) => n.nodeId === makeNodeId(id));
}

test('a failed node is recorded once, with its task, role, reason and run', async () => {
  const dag = dagOf([
    { id: 'impl', label: 'implement', agentRole: 'coder', retry: NO_WAIT },
    { id: 'ok', label: 'fine', agentRole: 'tester', retry: NO_WAIT },
  ]);
  dag.nodes.get(makeNodeId('impl'))!.metadata['taskDescription'] = 'Implement a token bucket in src/auth/login.ts';
  dag.nodes.get(makeNodeId('impl'))!.metadata['runTitle'] = 'Add rate limiting to the login endpoint';
  const recorder = capturing();

  const outcome = await new DagRunner().run({
    dag, board: new BlackboardStore(), failureRecorder: recorder,
    executor: async (node: DagNode): Promise<Record<string, BlackboardValue>> => {
      if (node.id === makeNodeId('impl')) {
        throw new NodeFailure('adapter_failed', 'claude exited 1: not logged in', 1);
      }
      return {};
    },
  });

  assert.equal(outcome.status, 'Failed');
  assert.deepEqual(recorder.records, [{
    runId:    RUN_ID,
    nodeId:   makeNodeId('impl'),
    label:    'implement',
    task:     'Implement a token bucket in src/auth/login.ts',
    runTitle: 'Add rate limiting to the login endpoint',
    role:     'coder',
    reason:   'adapter_failed',
    message:  'claude exited 1: not logged in',
    exitCode: 1,
  }], 'the succeeded node is not recorded');
});

test('an error that is not a NodeFailure is recorded under its class; the task falls back to the label', async () => {
  class SchemaMismatch extends Error {}
  const recorder = capturing();

  await new DagRunner().run({
    dag: dagOf([
      { id: 'a', label: 'refused', retry: NO_WAIT },
      { id: 'b', label: 'broken', retry: NO_WAIT },
      { id: 'c', label: 'threw a string', retry: NO_WAIT },
    ]),
    board: new BlackboardStore(), failureRecorder: recorder, isWriter: () => false,
    executor: async (node) => {
      if (node.id === makeNodeId('a')) throw new GateRefused('the security gate refused the diff', []);
      if (node.id === makeNodeId('b')) throw new SchemaMismatch('expected a json block');
      throw 'not an error';
    },
  });

  const byNode = new Map(recorder.records.map((r) => [r.nodeId, r]));
  assert.equal(recorder.records.length, 3);
  assert.equal(byNode.get(makeNodeId('a'))?.reason, 'GateRefused');
  assert.equal(byNode.get(makeNodeId('a'))?.task, 'refused');
  assert.equal(byNode.get(makeNodeId('b'))?.reason, 'SchemaMismatch');
  assert.equal(byNode.get(makeNodeId('b'))?.message, 'expected a json block');
  assert.equal(byNode.get(makeNodeId('c'))?.reason, 'non_error');
  assert.equal(byNode.get(makeNodeId('c'))?.message, 'not an error');
  assert.ok(!('exitCode' in byNode.get(makeNodeId('b'))!), 'no exit code is invented');
  assert.ok(!('runTitle' in byNode.get(makeNodeId('b'))!), 'no run title is invented');
});

test('a node retried on transport failure is recorded once, after its last attempt', async () => {
  const recorder = capturing();
  let calls = 0;

  const outcome = await new DagRunner().run({
    dag: dagOf([{ id: 'a', label: 'flaky', retry: { ...NO_WAIT, maxAttempts: 3 } }]),
    board: new BlackboardStore(), failureRecorder: recorder,
    executor: async () => {
      calls++;
      // The recorder must not have heard about an attempt that was going to be retried.
      assert.equal(recorder.records.length, 0, `attempt ${calls} ran after a failure was recorded`);
      throw new TransportError(`connection reset (attempt ${calls})`);
    },
  });

  assert.equal(calls, 3);
  assert.equal(nodeState(outcome, 'a')?.status, 'Failed');
  assert.equal(recorder.records.length, 1);
  assert.equal(recorder.records[0]?.reason, 'TransportError');
  assert.equal(recorder.records[0]?.message, 'connection reset (attempt 3)');
});

test('a transport failure that a retry recovers is not recorded', async () => {
  const recorder = capturing();
  let calls = 0;

  const outcome = await new DagRunner().run({
    dag: dagOf([{ id: 'a', label: 'flaky', retry: NO_WAIT }]),
    board: new BlackboardStore(), failureRecorder: recorder,
    executor: async (): Promise<Record<string, BlackboardValue>> => {
      calls++;
      if (calls === 1) throw new TransportError('connection reset');
      return {};
    },
  });

  assert.equal(outcome.status, 'Succeeded');
  assert.deepEqual(recorder.records, []);
});

test('a recorder that throws or rejects changes nothing about the run', async (t) => {
  const logged = t.mock.method(console, 'error', () => undefined);

  for (const recorder of [
    { recordFailure: async (): Promise<void> => { throw new Error('graph is down'); } },
    { recordFailure: (): Promise<void> => { throw new Error('graph is down'); } },
  ]) {
    logged.mock.resetCalls();
    const ended: Array<[string, string]> = [];

    const outcome = await new DagRunner().run({
      dag: dagOf([
        { id: 'a', label: 'a', retry: NO_WAIT },
        { id: 'b', label: 'b', dependencies: ['a'], retry: NO_WAIT },
        { id: 'c', label: 'c', retry: NO_WAIT },
      ]),
      board: new BlackboardStore(), failureRecorder: recorder, isWriter: () => false,
      executor: async (node) => {
        if (node.id === makeNodeId('a')) throw new NodeFailure('empty_output', 'the coder said nothing');
        return {};
      },
      onNodeEnd: (id, status) => { ended.push([id, status]); },
    });

    assert.equal(outcome.status, 'Failed');
    assert.equal(nodeState(outcome, 'a')?.error, 'the coder said nothing', 'the node keeps its own error');
    assert.equal(nodeState(outcome, 'c')?.status, 'Succeeded', 'an independent node still runs');
    assert.deepEqual(outcome.unscheduled, ['b']);
    assert.deepEqual(ended.find(([id]) => id === 'a'), ['a', 'Failed'], 'onNodeEnd still fires');
    const lines = logged.mock.calls.map((c) => c.arguments.map(String).join(' '));
    assert.ok(lines.some((l) => l.includes('node a') && l.includes('graph is down')),
      `the recorder's error is logged, naming the node: ${JSON.stringify(lines)}`);
  }
});
