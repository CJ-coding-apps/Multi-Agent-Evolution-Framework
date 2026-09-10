import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId, makeTaskId } from '@maf/types';
import {
  Processor,
  StaticProcessorRegistry,
  ProcessorPipeline,
  ContractViolation,
  ProcessorInterrupt,
  SecretRedactProcessor,
  createDefaultProcessorRegistry,
  DEFAULT_BUNDLE_REFS,
  redactSecrets,
  redactText,
  redactRecord,
} from '../index.js';
import type {
  HarnessEvent, StepEndEvent, BeforeModelEvent, ToolResultEvent, ToolCallEvent,
} from '../index.js';

// ORACLE: HARNESSX_INTEGRATION_PLAN.md §4.2 (hook contracts) and §4.4 (Phase 1 tests).

const ctx = { runId: makeRunId('r1'), taskId: makeTaskId('t1'), role: 'coder', harnessSha: 'a'.repeat(64) };

function stepEnd(): StepEndEvent {
  return { ...ctx, hook: 'step_end', stepIndex: 0, assistantText: 'done', toolCallCount: 1 };
}

class Stub extends Processor {
  override readonly name: string;
  override readonly hooks: readonly ('step_end' | 'before_model' | 'before_tool' | 'after_tool' | 'task_start')[];
  constructor(
    name: string,
    hooks: Stub['hooks'],
    private readonly fn: (e: HarnessEvent) => HarnessEvent[],
    opts?: { singletonGroup?: string; order?: 'PRE' | 'NORMAL' | 'POST'; softAfter?: string[] },
  ) {
    super();
    this.name = name;
    this.hooks = hooks;
    if (opts?.singletonGroup) (this as unknown as { singletonGroup?: string }).singletonGroup = opts.singletonGroup;
    if (opts?.order) (this as unknown as { order: string }).order = opts.order;
    if (opts?.softAfter) (this as unknown as { softAfter: string[] }).softAfter = opts.softAfter;
  }
  override async *process(event: HarnessEvent): AsyncGenerator<HarnessEvent> {
    for (const e of this.fn(event)) yield e;
  }
}

test('read-only hook: mutation of a field raises ContractViolation', async () => {
  const reg = new StaticProcessorRegistry()
    .register('mutator', () => new Stub('mutator', ['step_end'], (e) => [{ ...e, assistantText: 'hacked' }]));
  const pipe = ProcessorPipeline.build([{ name: 'mutator' }], reg, {});
  await assert.rejects(() => pipe.run(stepEnd()), ContractViolation);
});

test('read-only hook: pass-through yields the event unchanged', async () => {
  const reg = new StaticProcessorRegistry()
    .register('observer', () => new Stub('observer', ['step_end'], (e) => [e]));
  const pipe = ProcessorPipeline.build([{ name: 'observer' }], reg, {});
  const out = await pipe.run(stepEnd());
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], stepEnd());
});

test('before_model: appending more than one message violates the contract', async () => {
  const reg = new StaticProcessorRegistry().register('greedy', () => new Stub('greedy', ['before_model'],
    (e) => {
      const ev = e as BeforeModelEvent;
      return [{
        ...ev,
        history: [...ev.history,
          { kind: 'user', text: 'x' }, { kind: 'user', text: 'y' }],
      }];
    }));
  const pipe = ProcessorPipeline.build([{ name: 'greedy' }], reg, {});
  const input: BeforeModelEvent = {
    ...ctx, hook: 'before_model', stepIndex: 0, history: [{ kind: 'user', text: 'hi' }],
  };
  await assert.rejects(() => pipe.run(input), ContractViolation);
});

test('before_model: one appended user message is legal', async () => {
  const reg = new StaticProcessorRegistry().register('append', () => new Stub('append', ['before_model'],
    (e) => {
      const ev = e as BeforeModelEvent;
      return [{ ...ev, history: [...ev.history, { kind: 'user' as const, text: 'extra' }] }];
    }));
  const pipe = ProcessorPipeline.build([{ name: 'append' }], reg, {});
  const input: BeforeModelEvent = {
    ...ctx, hook: 'before_model', stepIndex: 0, history: [{ kind: 'user', text: 'hi' }],
  };
  const out = await pipe.run(input);
  assert.equal((out[0] as BeforeModelEvent).history.length, 2);
});

test('singleton-group conflict: build rejects two processors in the same group', () => {
  const reg = new StaticProcessorRegistry()
    .register('a', () => new Stub('a', ['step_end'], (e) => [e], { singletonGroup: 'g' }))
    .register('b', () => new Stub('b', ['step_end'], (e) => [e], { singletonGroup: 'g' }));
  assert.throws(
    () => ProcessorPipeline.build([{ name: 'a' }, { name: 'b' }], reg, {}),
    ContractViolation,
  );
});

test('split: two outputs flow independently through the downstream processor', async () => {
  const seen: string[] = [];
  const reg = new StaticProcessorRegistry()
    .register('splitter', () => new Stub('splitter', ['before_tool'],
      (e) => {
        const ev = e as ToolCallEvent;
        return [ev, { ...ev, call: { ...ev.call, input: { ...ev.call.input, copy: true } } }];
      }, { order: 'PRE' }))
    .register('recorder', () => new Stub('recorder', ['before_tool'],
      (e) => { seen.push(JSON.stringify((e as ToolCallEvent).call.input)); return [e]; }));
  const pipe = ProcessorPipeline.build([{ name: 'recorder' }, { name: 'splitter' }], reg, {});
  const input: ToolCallEvent = {
    ...ctx, hook: 'before_tool', stepIndex: 0,
    call: { toolUseId: 'u1', toolName: 'fs.read', input: { path: 'a' } },
  };
  const out = await pipe.run(input);
  assert.equal(out.length, 2);
  assert.deepEqual(seen.sort(), ['{"path":"a"}', '{"path":"a","copy":true}'].sort());
});

test('intercept on a read-only hook is a contract violation', async () => {
  const reg = new StaticProcessorRegistry()
    .register('blocker', () => new Stub('blocker', ['step_end'], () => []));
  const pipe = ProcessorPipeline.build([{ name: 'blocker' }], reg, {});
  await assert.rejects(() => pipe.run(stepEnd()), ContractViolation);
});

test('intercept on before_tool yields empty (legal)', async () => {
  const reg = new StaticProcessorRegistry()
    .register('blocker', () => new Stub('blocker', ['before_tool'], () => []));
  const pipe = ProcessorPipeline.build([{ name: 'blocker' }], reg, {});
  const input: ToolCallEvent = {
    ...ctx, hook: 'before_tool', stepIndex: 0,
    call: { toolUseId: 'u', toolName: 'x', input: {} },
  };
  assert.deepEqual(await pipe.run(input), []);
});

test('unknown processor ref fails at build time', () => {
  const reg = new StaticProcessorRegistry();
  assert.throws(() => ProcessorPipeline.build([{ name: 'nope' }], reg, {}), /Unknown processor ref/);
});

test('SecretRedactProcessor redacts credentials from tool results', async () => {
  const p = new SecretRedactProcessor({});
  const event: ToolResultEvent = {
    ...ctx, hook: 'after_tool', stepIndex: 0,
    call: { toolUseId: 'u', toolName: 'fs.read', input: {} },
    result: {
      stdout: 'key is AKIAIOSFODNN7EXAMPLE and sk-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstuvwx',
      stderr: 'nothing here', exitCode: 0, duration: 1, metadata: {},
    },
  };
  const g = p.process(event);
  const first = await g.next();
  const out = first.value as ToolResultEvent;
  assert.ok(out.result.stdout.includes('[REDACTED:aws-access-key]'));
  assert.ok(out.result.stdout.includes('[REDACTED:openai-key]'));
  assert.ok(out.result.stdout.includes('[REDACTED:bearer]'));
  assert.ok(!out.result.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('default registry builds the default bundle without violations', async () => {
  const appended: string[] = [];
  const reg = createDefaultProcessorRegistry();
  const pipe = ProcessorPipeline.build([...DEFAULT_BUNDLE_REFS], reg, {
    transcript: { append: async (_r, content) => { appended.push(content); } },
    securityRunner: async () => { appended.push('security-ran'); },
  });
  const out = await pipe.run(stepEnd());
  assert.equal(out.length, 1);
  const end: HarnessEvent = { ...ctx, hook: 'task_end', finalText: 'x', totalSteps: 1, outcome: 'completed' };
  await pipe.run(end);
  assert.ok(appended.some((c) => c.includes('task_end')));
  assert.ok(appended.includes('security-ran'), 'coder task_end runs the security gate');
});

test('M2: coder security gate runs at task_end on budget_exhausted (not only completed)', async () => {
  const appended: string[] = [];
  const reg = createDefaultProcessorRegistry();
  const pipe = ProcessorPipeline.build([...DEFAULT_BUNDLE_REFS], reg, {
    transcript: { append: async () => {} },
    securityRunner: async () => { appended.push('security-ran'); },
  });
  const end: HarnessEvent = {
    ...ctx, hook: 'task_end', finalText: 'partial', totalSteps: 3,
    outcome: 'budget_exhausted', error: 'hit maxTurns',
  };
  await pipe.run(end);
  assert.ok(appended.includes('security-ran'),
    'a budget-exhausted coder run must still be security-reviewed');
});

test('L1: redactSecrets (evidence-grade) scrubs credential FORMATS, byte-faithful otherwise', () => {
  const raw = 'line before\nexport KEY=AKIAIOSFODNN7EXAMPLE and sk-ant-abcdefghijklmnopqrstuvwxyz\nline after';
  const out = redactSecrets(raw);
  // secrets gone
  assert.ok(out.includes('[REDACTED:aws-access-key]'));
  assert.ok(out.includes('[REDACTED:anthropic-key]'));
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  // byte-faithful: everything that is NOT a secret is preserved exactly
  const expected = raw
    .replace('AKIAIOSFODNN7EXAMPLE', '[REDACTED:aws-access-key]')
    .replace('sk-ant-abcdefghijklmnopqrstuvwxyz', '[REDACTED:anthropic-key]');
  assert.equal(out, expected);
});

test('L1: redactSecrets does NOT apply broad assignment heuristics (keeps evidence faithful)', () => {
  // A legitimate `password:` line in reviewed source must survive in the attestation.
  const raw = 'config.password: examplepassword123';
  assert.equal(redactSecrets(raw), raw, 'evidence-grade redaction leaves non-key content intact');
  // but the model-facing redactText does strip it
  assert.ok(redactText(raw).includes('[REDACTED:generic-secret]'));
});

test('L1: redactRecord scrubs string metadata values, leaves non-strings', () => {
  const out = redactRecord({ note: 'sk-abcdefghijklmnopqrstuvwxyz', count: 3, ok: true });
  assert.ok(String(out['note']).includes('[REDACTED:openai-key]'));
  assert.equal(out['count'], 3);
  assert.equal(out['ok'], true);
});

test('L2: deleting an immutable field is caught (union-of-keys check)', async () => {
  const reg = new StaticProcessorRegistry().register('deleter', () => new Stub('deleter', ['step_end'],
    (e) => {
      const copy: Record<string, unknown> = { ...(e as StepEndEvent) };
      delete copy['assistantText']; // immutable field removed → must be caught
      return [copy as unknown as HarnessEvent];
    }));
  const pipe = ProcessorPipeline.build([{ name: 'deleter' }], reg, {});
  await assert.rejects(() => pipe.run(stepEnd()), ContractViolation);
});

test('L2: before_model editing the last user message text is legal', async () => {
  const reg = new StaticProcessorRegistry().register('edit', () => new Stub('edit', ['before_model'],
    (e) => {
      const ev = e as BeforeModelEvent;
      const hist = [...ev.history];
      hist[hist.length - 1] = { kind: 'user' as const, text: 'edited' };
      return [{ ...ev, history: hist }];
    }));
  const pipe = ProcessorPipeline.build([{ name: 'edit' }], reg, {});
  const input: BeforeModelEvent = {
    ...ctx, hook: 'before_model', stepIndex: 0,
    history: [{ kind: 'assistant', text: 'a', toolCalls: [] }, { kind: 'user', text: 'hi' }],
  };
  const out = await pipe.run(input);
  assert.equal((out[0] as BeforeModelEvent).history[1]?.kind === 'user'
    && (out[0] as BeforeModelEvent).history[1] && ((out[0] as BeforeModelEvent).history[1] as { text: string }).text, 'edited');
});

test('L2: before_model rewriting a PRIOR history message is rejected', async () => {
  const reg = new StaticProcessorRegistry().register('rewrite', () => new Stub('rewrite', ['before_model'],
    (e) => {
      const ev = e as BeforeModelEvent;
      const hist = [...ev.history];
      hist[0] = { kind: 'user' as const, text: 'TAMPERED' };
      return [{ ...ev, history: hist }];
    }));
  const pipe = ProcessorPipeline.build([{ name: 'rewrite' }], reg, {});
  const input: BeforeModelEvent = {
    ...ctx, hook: 'before_model', stepIndex: 0,
    history: [{ kind: 'user', text: 'a' }, { kind: 'user', text: 'b' }],
  };
  await assert.rejects(() => pipe.run(input), ContractViolation);
});

test('ProcessorInterrupt propagates out of the pipeline', async () => {
  const reg = new StaticProcessorRegistry().register('killswitch', () => new Stub('killswitch', ['after_tool'],
    () => { throw new ProcessorInterrupt('killswitch', 'test'); }));
  const pipe = ProcessorPipeline.build([{ name: 'killswitch' }], reg, {});
  const input: ToolResultEvent = {
    ...ctx, hook: 'after_tool', stepIndex: 0,
    call: { toolUseId: 'u', toolName: 'x', input: {} },
    result: { stdout: '', stderr: '', exitCode: 0, duration: 0, metadata: {} },
  };
  await assert.rejects(() => pipe.run(input), ProcessorInterrupt);
});
