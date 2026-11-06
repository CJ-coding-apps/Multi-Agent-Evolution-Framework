import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type {
  AdapterInvokeOptions, AdapterInvokeResult, AssistantTurn, AttestationBundle, ModelSurfaceRecord,
  TurnMessage,
} from '@maf/types';
import { TransportError, sha256Hex, withModelSurface } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { ScriptedExchange, ScriptedTask } from '@maf/eval-harness';
import { Attestor, MAF_RUN_PREDICATE_TYPE, parseBundle } from '@maf/attestation';
import type { InTotoStatement } from '@maf/attestation';
import {
  FIXED_SUM, dirtyUserRepo, driveRun, needsLcm, onePlannedNode, registryOf,
} from './runFixture.js';

// ORACLE (L1 of the WP-3.2 live rows): the bundle's `modelSurfaces` was not a complete account of
// what each model was shown. A run's planner call and its security gate's call are model calls MAF
// makes directly; neither recorded a surface, and the code said so itself. The live rows' common
// setup — "every adapter call matches exactly one surface" — is the test below.

const TASK = 'Fix the bug in sum.js so the test passes';
const KEY = 'surfaces-signing-key';

/** A scripted model that also reports the in-process surface a real backend reports (F4). */
class SurfaceReportingScripted extends ScriptedAdapter {
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    const turn = await super.sendTurn(history, o);
    return {
      ...turn,
      modelSurface: { systemPromptSha256: sha256Hex(o.systemPrompt ?? ''), toolCatalog: '', argv: [] },
    };
  }
}

/**
 * The scripted model on the cli tier: it reports no surface and cannot run the in-process loop,
 * which is the shape of `ollama` and `openrouter` (L1-S1). Every call it answers is an `invoke`.
 */
class CliTierScripted extends ScriptedAdapter {
  override capabilities() {
    return { ...super.capabilities(), inProcessLoop: false };
  }
}

/**
 * The cli-tier model whose governed role call throws (R2-S1): the backend takes the call and exits
 * without answering, the way a timeout or a non-zero exit reaches the dispatcher. The exchange is
 * pushed before the throw, exactly as `ScriptedAdapter` pushes one, so the bijection sees a call
 * the adapter really took.
 */
class CliTierThrowsOnRole extends CliTierScripted {
  override async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    if (o.prompt !== TASK) return super.invoke(o);
    this.exchanges.push({
      via: 'invoke', kind: 'task', systemPrompt: o.systemPrompt ?? '', prompt: o.prompt, tools: o.tools ?? [],
    });
    throw new Error('the backend exited before answering');
  }
}

/** The in-process model whose first governed turn throws (R2-S1). */
class InProcessThrowsOnTurn extends ScriptedAdapter {
  override async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    const first = history.find((m) => m.kind === 'user');
    this.exchanges.push({
      via: 'turn', kind: 'task', systemPrompt: o.systemPrompt ?? '',
      prompt: first && first.kind === 'user' ? first.text : '', tools: o.tools ?? [],
    });
    throw new Error('the backend exited mid-turn');
  }
}

type ExchangeKind = 'role-turn' | 'summary' | 'planner' | 'security-gate' | 'other';

/**
 * Which model call an exchange was, read from the prompt alone — the same way an operator reading
 * the transcript would. A summary call is `@maf/lcm`'s (WP-3.2), made through `invoke` with the
 * summarization system prompt; the compacting run below is the one that makes it.
 */
function exchangeKind(e: ScriptedExchange): ExchangeKind {
  if (e.via === 'turn') return 'role-turn';
  if (/^Create a task execution DAG for:/.test(e.prompt)) return 'planner';
  if (/^Audit (this diff|these files) for security issues\./.test(e.prompt)) return 'security-gate';
  if (e.systemPrompt.startsWith('You are a context summarization agent')) return 'summary';
  // A cli-tier role call (L1-S1): the adapter's own `task` exchange that is neither planner nor gate.
  if (e.via === 'invoke' && e.kind === 'task') return 'role-turn';
  return 'other';
}

/** A surface record's kind as the exchange's word for it: absent is a role call (it predates the field). */
function surfaceKind(s: ModelSurfaceRecord): ExchangeKind {
  const kind = s.kind;
  if (kind === undefined || kind === 'role-call') return 'role-turn';
  if (kind === 'lcm-summary') return 'summary';
  return kind;
}

/** The digest key a surface record is matched by. An in-process turn has no prompt/output digest. */
function surfaceKey(s: ModelSurfaceRecord): string {
  return `${s.systemPromptSha256}|${s.promptSha256 ?? ''}|${s.outputSha256 ?? ''}`;
}

/**
 * The same key, computed from what the adapter was handed and answered. An `invoke` that threw
 * answered with no text at all, so its output component is absent — the same thing
 * `surfaceKey`'s `outputSha256 ?? ''` says — not the digest of an empty string, which is what an
 * adapter that answered `''` carries (R2-S1).
 */
function exchangeKey(e: ScriptedExchange): string {
  if (e.via === 'turn') return `${sha256Hex(e.systemPrompt)}||`;
  return `${sha256Hex(e.systemPrompt)}|${sha256Hex(e.prompt)}|${e.output === undefined ? '' : sha256Hex(e.output)}`;
}

/**
 * The common-setup rule — "every adapter call matches exactly one surface record, none unmatched" —
 * as a bijection by digests within each kind. Used by every scenario in this file (L1-S6).
 */
function assertBijection(surfaces: readonly ModelSurfaceRecord[], exchanges: readonly ScriptedExchange[]): void {
  const pool = new Map<string, string[]>();
  for (const s of surfaces) {
    const kind = surfaceKind(s);
    pool.set(kind, [...(pool.get(kind) ?? []), surfaceKey(s)]);
  }
  for (const e of exchanges) {
    const kind = exchangeKind(e);
    assert.notEqual(kind, 'other', `unclassified adapter call: ${e.via} ${JSON.stringify(e.prompt.slice(0, 80))}`);
    const keys = pool.get(kind) ?? [];
    const at = keys.indexOf(exchangeKey(e));
    assert.notEqual(at, -1, `no ${kind} surface matches ${e.via} ${JSON.stringify(e.prompt.slice(0, 80))}`);
    keys.splice(at, 1);
    pool.set(kind, keys);
  }
  for (const [kind, keys] of pool) {
    assert.deepEqual(keys, [], `${kind} surface record(s) match no adapter call`);
  }
}

/** Drives a run and reads the signed bundle it wrote. */
async function runAndRead(
  repo: string,
  scripted: ScriptedAdapter,
  extra: readonly string[],
  task: string = TASK,
  /** A refusing gate or a failed planning call ends the run in an error — the bundle is still read. */
  expect: 'success' | 'failure' = 'success',
): Promise<{
  surfaces: ModelSurfaceRecord[];
  exchanges: ScriptedExchange[];
  bundleText: string;
  runId: string;
  run: Awaited<ReturnType<typeof driveRun>>;
}> {
  const run = await driveRun([task, '--dir', repo, '--adapter', 'scripted', ...extra], {
    adapters: registryOf(scripted),
    io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: KEY } },
  });
  if (expect === 'success') assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
  else assert.notEqual(run.error, undefined, 'the run was expected to fail');
  const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
  assert.ok(runId, run.out);
  const bundleText = await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8');
  const statement = JSON.parse(bundleText) as InTotoStatement<AttestationBundle>;
  assert.equal(statement.predicateType, MAF_RUN_PREDICATE_TYPE);
  assert.equal(Attestor.report(parseBundle(bundleText), { secret: KEY }).valid, true);
  return { surfaces: statement.predicate.modelSurfaces ?? [], exchanges: scripted.exchanges, bundleText, runId, run };
}

const PLAN_TEXT = 'One node of the default role does the whole task.';
const CLEAN_REVIEW = JSON.stringify({ findings: [], summary: 'clean', passed: true });
const BLOCKING_REVIEW = JSON.stringify({
  findings: [{ severity: 'critical', category: 'injection', file: 'sum.js', line: 1, rationale: 'exec', remediation: 'drop it' }],
  summary: 'a critical finding', passed: false,
});

const answered = (output: string, success = true): AdapterInvokeResult =>
  ({ success, output, toolCallLog: [], exitCode: success ? 0 : 1, duration: 0 });
const transportFailure = (): AdapterInvokeResult => ({
  success: false, output: '', toolCallLog: [], exitCode: 124, duration: 0,
  transportError: new TransportError('the reviewer did not finish in time'),
});

/** The coder script the happy path uses: read the buggy file, write the fixed one. */
const CODER: ScriptedTask = {
  prompt: TASK,
  steps: [
    { tool: 'fs.read', input: { path: 'sum.js' } },
    { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
  ],
  final: 'Fixed sum.js: a - b → a + b.',
};

/**
 * The scripted model with a scripted planner and gate (L1-S6). Each queue answers the next call of
 * that kind; an exhausted queue delegates to the script. The exchange is pushed exactly as
 * `ScriptedAdapter` pushes one, so the bijection sees a call the adapter really answered — a
 * failure and a retry are as visible in `exchanges` as a success.
 */
class ScriptedCalls extends ScriptedAdapter {
  private readonly plannerAnswers: Array<AdapterInvokeResult | undefined> = [];
  private readonly gateAnswers: Array<AdapterInvokeResult | undefined> = [];

  override async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const planner = /^Create a task execution DAG for:/.test(o.prompt);
    const gate = /^Audit (this diff|these files) for security issues\./.test(o.prompt);
    const answer = (planner ? this.plannerAnswers : gate ? this.gateAnswers : []).shift();
    if (answer === undefined) return super.invoke(o);
    this.exchanges.push({
      via: 'invoke', kind: planner ? 'task' : 'security-review',
      systemPrompt: o.systemPrompt ?? '', prompt: o.prompt, output: answer.output, tools: o.tools ?? [],
    });
    return answer;
  }

  planner(...answers: Array<AdapterInvokeResult | undefined>): this { this.plannerAnswers.push(...answers); return this; }
  gate(...answers: Array<AdapterInvokeResult | undefined>): this { this.gateAnswers.push(...answers); return this; }
}

test('L1: every adapter call of every kind matches exactly one surface record, none unmatched', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new SurfaceReportingScripted([{
      prompt: `Create a task execution DAG for: ${TASK}\n\n${TASK}`,
      steps: [],
      final: 'One node of the default role does the whole task.',
    }, {
      prompt: TASK,
      steps: [
        { tool: 'fs.read', input: { path: 'sum.js' } },
        { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
      ],
      final: 'Fixed sum.js: a - b → a + b.',
    }]);

    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted'], {
      adapters: registryOf(scripted),
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: KEY } },
    });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const file = path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`);
    const text = await readFile(file, 'utf8');
    const statement = JSON.parse(text) as InTotoStatement<AttestationBundle>;
    assert.equal(statement.predicateType, MAF_RUN_PREDICATE_TYPE);
    assert.equal(Attestor.report(parseBundle(text), { secret: KEY }).valid, true);

    const surfaces = statement.predicate.modelSurfaces ?? [];
    const exchanges = scripted.exchanges;
    assert.ok(exchanges.length > 0, 'the run made model calls');

    // The two kinds the live row found missing are present, once each.
    const planners = surfaces.filter((s) => s.kind === 'planner');
    const gates = surfaces.filter((s) => s.kind === 'security-gate');
    const turns = surfaces.filter((s) => s.kind === undefined || s.kind === 'role-call');
    assert.equal(planners.length, 1, 'one planning call, one record');
    assert.equal(gates.length, 1, 'one gated writer, one review, one record');
    assert.ok(turns.length > 0, 'the coder turns are in the same array');

    const planner = planners[0];
    assert.ok(planner);
    assert.equal(planner.role, 'planner');
    assert.equal(planner.tier, 'cli');
    assert.equal(planner.nativeTools, 'none', 'the planner asks for text only');
    assert.equal(planner.taskId, 'planner', 'the planner is the run\'s call, not a node\'s');
    assert.equal('model' in planner, false, 'no --model was given, so no model was named');

    const gate = gates[0];
    assert.ok(gate);
    assert.equal(gate.role, 'security');
    assert.equal(gate.tier, 'cli');
    assert.equal(gate.nativeTools, 'none', 'a diff review asks for no native tools');
    const nodeTaskId = turns[0]?.taskId;
    assert.ok(nodeTaskId, 'the coder turn names its node');
    assert.equal(gate.taskId, nodeTaskId, 'the gate record names the node whose diff it reviewed');
    assert.equal('model' in gate, false);

    // Both new records are in the signed predicate, not merely in the transcript: the check above
    // verified the statement's signature over the predicate these arrays were read from.

    // ── the common-setup rule: a bijection by digests, within each kind ──
    assertBijection(surfaces, exchanges);

    // L1-S9: both direct calls are mirrored into the transcript as they happen, so the run says
    // which calls it made even before (or without) its bundle. The line is the record's, not a
    // second copy of model text: the digests and the call's kind.
    const logDir = path.join(repo, '.maf', 'transcripts');
    const transcript = (await Promise.all(
      (await readdir(logDir)).map((file) => readFile(path.join(logDir, file), 'utf8')),
    )).join('');
    assert.match(transcript, /\[surface\] planner turn 1: system sha256 /);
    assert.match(transcript, /\[surface\] security-gate turn 1: system sha256 /);

    // Sanity: the digest the record carries is the digest of the bytes the adapter saw.
    const plannerCall = exchanges.find((e) => exchangeKind(e) === 'planner');
    assert.ok(plannerCall);
    assert.equal(planner.systemPromptSha256, sha256Hex(plannerCall.systemPrompt));
    assert.equal(planner.promptSha256, sha256Hex(plannerCall.prompt));
    assert.equal(planner.outputSha256, sha256Hex(plannerCall.output ?? ''));
    assert.deepEqual(planner.argv, [], 'no argv is invented for an adapter that reported none');
    assert.equal(
      planner.outputSha256,
      crypto.createHash('sha256').update(plannerCall.output ?? '').digest('hex'),
      'the digest form is sha256 hex',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// L1-S1: the record is not the adapter's to withhold. A governed turn whose adapter reports no
// surface still gets an entry — the system block the loop handed it is known exactly — and the
// prompt and output stay absent rather than being hashed as empty strings.
test('L1-S1: an in-process adapter that reports no surface still records one per turn', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-nosurface-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [
        { tool: 'fs.read', input: { path: 'sum.js' } },
        { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
      ],
      final: 'Fixed sum.js: a - b → a + b.',
    }]);
    const { surfaces, exchanges } = await runAndRead(repo, scripted, []);

    const turns = surfaces.filter((s) => s.kind === 'role-call');
    const turnCalls = exchanges.filter((e) => e.via === 'turn');
    assert.equal(turns.length, turnCalls.length, 'one record per governed turn');
    assert.ok(turns.length > 0, 'the governed turns happened');
    const handed = new Set(turnCalls.map((e) => sha256Hex(e.systemPrompt)));
    for (const turn of turns) {
      assert.equal(turn.tier, 'in-process');
      assert.ok(handed.has(turn.systemPromptSha256), 'the digest is of the system block that was sent');
      assert.equal(turn.promptSha256, undefined, 'a turn has no single prompt string, so none is invented');
      assert.equal(turn.outputSha256, undefined, 'a turn answers a parsed turn, not one output string');
      assert.deepEqual(turn.argv, [], 'no argv is invented for an adapter that reported none');
    }
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// L1-S1: `ollama` and `openrouter` cannot run the loop and report no surface, so before this fix
// every role call through them was dropped from the record. The call site knows what it sent and
// what came back, and those digests are the same evidence a reporting adapter carries.
test('L1-S1: a cli-tier adapter that reports no surface records the planner, the gate and the role call', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-cli-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new CliTierScripted([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [
        { tool: 'fs.read', input: { path: 'sum.js' } },
        { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
      ],
      final: 'Fixed sum.js: a - b → a + b.',
    }]);
    const { surfaces, exchanges } = await runAndRead(repo, scripted, ['--allow-ungoverned']);

    assert.equal(surfaces.filter((s) => s.kind === 'planner').length, 1, 'one planning call, one record');
    assert.equal(surfaces.filter((s) => s.kind === 'security-gate').length, 1, 'one review, one record');
    const roles = surfaces.filter((s) => s.kind === 'role-call');
    assert.equal(roles.length, 1, 'the cli-tier role call is in the record');
    const role = roles[0];
    assert.ok(role);
    assert.equal(role.tier, 'cli');
    assert.equal(role.nativeTools, 'full');
    assert.equal(role.outputSha256, sha256Hex('Fixed sum.js: a - b → a + b.'));
    const roleCall = exchanges.find((e) => e.via === 'invoke' && e.prompt === TASK);
    assert.ok(roleCall, 'the role call the adapter answered is the one recorded');
    assert.equal(role.promptSha256, sha256Hex(roleCall.prompt));
    assert.equal(role.systemPromptSha256, sha256Hex(roleCall.systemPrompt));
    assert.deepEqual(role.argv, [], 'no argv is invented for an adapter that reported none');

    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── R2-S1: a call that throws is a call ────────────────────────────────────────────────────────────
// The record is written from the call's `finally`, not after it. A backend that times out or exits
// non-zero took the turn this run asked for; recording only on return drops exactly the turn a
// reader most needs to see. The surface sent is known, the answer is not, so `error: 'thrown'` and
// no `outputSha256`.

test('R2-S1: a cli-tier role call that throws is recorded once, with what was sent and no output digest', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-cli-throw-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new CliTierThrowsOnRole([onePlannedNode(TASK)]);
    const { surfaces, exchanges } = await runAndRead(repo, scripted, ['--allow-ungoverned'], TASK, 'failure');

    const roles = surfaces.filter((s) => s.kind === 'role-call');
    assert.equal(roles.length, 1, 'one call that threw, one record: not zero, and not one per attempt');
    const role = roles[0];
    assert.ok(role);
    assert.equal(role.tier, 'cli');
    assert.equal(role.error, 'thrown');
    assert.equal(role.outputSha256, undefined, 'the call answered with no bytes, so none are hashed');

    const call = exchanges.find((e) => e.via === 'invoke' && e.prompt === TASK);
    assert.ok(call, 'the adapter took the role call before throwing');
    assert.equal(role.systemPromptSha256, sha256Hex(call.systemPrompt), 'the surface sent is still known');
    assert.equal(role.promptSha256, sha256Hex(call.prompt));

    // A mutant that records only on return leaves the throwing call unmatched: the exchange has no
    // surface, and the bijection fails in both directions it checks.
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R2-S1: an in-process turn that throws is recorded once, with the system digest and no output digest', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-turn-throw-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new InProcessThrowsOnTurn([onePlannedNode(TASK)]);
    const { surfaces, exchanges } = await runAndRead(repo, scripted, [], TASK, 'failure');

    const roles = surfaces.filter((s) => s.kind === 'role-call');
    assert.equal(roles.length, 1, 'one governed turn that threw, one record');
    const role = roles[0];
    assert.ok(role);
    assert.equal(role.tier, 'in-process');
    assert.equal(role.error, 'thrown');
    assert.equal(role.outputSha256, undefined, 'the turn answered with no parsed surface');
    assert.equal(role.promptSha256, undefined, 'a turn has no single prompt string, so none is invented');

    const call = exchanges.find((e) => e.via === 'turn');
    assert.ok(call, 'the adapter took the turn before throwing');
    assert.equal(role.systemPromptSha256, sha256Hex(call.systemPrompt), 'the system block sent is known');
    assert.deepEqual(role.argv, []);

    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── L1-S6: the bijection must be able to fail on every path it claims to cover ────────────────────
// Each test drives one path the live rows exercise — a retried planner, a judged failure, a gate that
// refuses, a gate whose call is retried, a repeated review — and asserts the exact number of records.
// A mutant that records only on success, twice per attempt, or not at all on a failure changes a count.

test('L1-S6: a planner retried after a transport failure records one surface per attempt, then goes on', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-retry-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedCalls([onePlannedNode(TASK), CODER]);
    scripted.planner(transportFailure(), answered(PLAN_TEXT));
    const { surfaces, exchanges } = await runAndRead(repo, scripted, []);

    const planners = surfaces.filter((s) => s.kind === 'planner');
    assert.equal(planners.length, 2, 'one per attempt: not zero for the failed one, not two for either');
    assert.equal(planners[0]?.outputSha256, sha256Hex(''), 'the timed-out attempt answered with no bytes');
    assert.equal(planners[1]?.outputSha256, sha256Hex(PLAN_TEXT));
    // A retry is a second attempt and its own record: a mutant that pushes twice per attempt leaves
    // four here, and one that records only a successful call leaves one.
    assert.equal(new Set(planners.map((p) => p.turn)).size, 1, 'both attempts are turn 1 of the planner');
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('L1-S6: a judged planner failure is recorded once, and the run\'s bundle holds it', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-planner-fail-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedCalls([onePlannedNode(TASK), CODER]);
    scripted.planner(answered('Error: Credit balance is too low', false));
    const { surfaces, exchanges, bundleText } = await runAndRead(repo, scripted, [], TASK, 'failure');

    const planners = surfaces.filter((s) => s.kind === 'planner');
    assert.equal(planners.length, 1, 'a judged failure is a call, and it is in the record');
    assert.equal(planners[0]?.outputSha256, sha256Hex('Error: Credit balance is too low'),
      'the error text is what the model answered, so it is what the output digest covers');
    const statement = JSON.parse(bundleText) as InTotoStatement<AttestationBundle>;
    assert.deepEqual(statement.subject, [], 'no node ran, so no subject');
    assert.equal(statement.predicate.outcome.status, 'Failed');
    assert.equal(statement.predicate.outcome.failure?.kind, 'planning_failed');
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('L1-S6: a gate that refuses still records its one call, with the finding it answered', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-gate-refuse-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedCalls([onePlannedNode(TASK), CODER]);
    scripted.gate(answered(BLOCKING_REVIEW));
    const { surfaces, exchanges, bundleText } = await runAndRead(repo, scripted, [], TASK, 'failure');

    const gates = surfaces.filter((s) => s.kind === 'security-gate');
    assert.equal(gates.length, 1, 'a review that blocked is a model call; a pass-only record would lose it');
    assert.equal(gates[0]?.outputSha256, sha256Hex(BLOCKING_REVIEW));
    const statement = JSON.parse(bundleText) as InTotoStatement<AttestationBundle>;
    assert.equal(statement.predicate.outcome.nodes?.[0]?.failure?.kind, 'gate_refused');
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('L1-S6: a gate call retried after a transport failure records both attempts, exactly', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-gate-retry-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedCalls([onePlannedNode(TASK), CODER]);
    // Two attempts: the first review times out, the node is retried (D-06), the second review passes.
    scripted.gate(transportFailure(), answered(CLEAN_REVIEW));
    const { surfaces, exchanges } = await runAndRead(repo, scripted, []);

    const gates = surfaces.filter((s) => s.kind === 'security-gate');
    assert.equal(gates.length, 2, 'the timed-out review and the one that passed, and nothing else');
    assert.equal(gates[0]?.outputSha256, sha256Hex(''));
    assert.equal(gates[1]?.outputSha256, sha256Hex(CLEAN_REVIEW));
    // A repeated review is two calls for the same node; each is one record. A mutant that pushes
    // twice per review leaves four.
    assert.equal(gates[0]?.taskId, gates[1]?.taskId, 'both reviews name the node that was retried');
    assertBijection(surfaces, exchanges);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── WP-3.2 F1, with WP-3.0c's rules applied to the lane ───────────────────────────────────────────
// `@maf/lcm` compacts by asking the run's own adapter for a summary, and that call used to reach the
// adapter without a surface record: the bundle's account of what the model was shown was one call
// short per compaction. A summary attempt that failed left no trace at all. The run below is
// configured to compact on its first assembly (a threshold low enough that any history is over it,
// and a fresh tail of one), and its model *returns* a transport failure on the first summary
// attempt — so the bijection has to pair the retried attempt, the one that replaced it, and every
// planner, gate and turn call around them.

/**
 * The scripted model that answers summarization prompts, failing the first attempt with a *returned*
 * transport failure (a timeout result, not a throw) — the Z1 shape.
 */
class SummaryScripted extends ScriptedAdapter {
  private attempts = 0;

  override async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    if (!(o.systemPrompt ?? '').startsWith('You are a context summarization agent')) return super.invoke(o);
    this.attempts += 1;
    const exchange: ScriptedExchange = {
      via: 'invoke', kind: 'task', systemPrompt: o.systemPrompt ?? '', prompt: o.prompt, tools: o.tools ?? [],
    };
    this.exchanges.push(exchange);
    if (this.attempts === 1) {
      exchange.output = '';
      return transportFailure();
    }
    exchange.output = `Summary ${this.attempts}: the run read sum.js and fixed the subtraction.`;
    return answered(exchange.output);
  }

  /** How many summary attempts the run made — the count the records must account for. */
  get summaryAttempts(): number { return this.attempts; }
}

/**
 * A repo whose every assembly compacts: the LCM threshold is low enough that any history is over it,
 * and only the newest message is protected.
 */
async function compactingRepo(root: string, operator: 'llm-map' | 'agentic-map' = 'llm-map'): Promise<string> {
  const repo = await dirtyUserRepo(root);
  const mafDir = path.join(repo, '.maf');
  await mkdir(mafDir, { recursive: true });
  await writeFile(path.join(mafDir, 'config.yaml'), [
    'lcm:',
    '  mode: Upward',
    `  operator: ${operator}`,
    '  contextThreshold: 0.001',
    '  freshTailCount: 1',
    '  summaryTimeoutMs: 4321',
    '',
  ].join('\n'), 'utf8');
  return repo;
}

test('F1: a compacting run records one surface per summary attempt, including the one that failed', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-compact-'));
  try {
    const repo = await compactingRepo(root);
    const scripted = new SummaryScripted([onePlannedNode(TASK), CODER]);
    const { surfaces, exchanges, runId } = await runAndRead(repo, scripted, []);

    const summaries = surfaces.filter((s) => s.kind === 'lcm-summary');
    const attempts = scripted.summaryAttempts;
    assert.ok(attempts >= 2, 'the run compacted, and the first summary attempt was retried');
    assert.equal(summaries.length, attempts, 'one record per summary attempt: no attempt is dropped or doubled');

    const failed = summaries.filter((s) => s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the timed-out attempt is recorded, once');
    const timedOut = failed[0];
    assert.ok(timedOut);
    assert.equal(timedOut.role, 'lcm');
    assert.equal(timedOut.tier, 'cli', 'the summary went through the adapter\'s `invoke`');
    assert.equal(timedOut.nativeTools, 'none', 'a summary asks for text only');
    // Z1: the adapter *returned* this failure (a `transportError` result); it did not throw. A call
    // that came back records its output digest and no `error`, exactly as the planner and the gate
    // record the same result. `error: 'thrown'` here is the mutant this assertion kills.
    assert.equal(timedOut.error, undefined, 'the adapter returned a failed result, so the call did come back');
    assert.equal(timedOut.surfaceSource, 'fallback', 'the scripted adapter reported no surface, so the summarizer built one');
    assert.equal(timedOut.outputSha256, sha256Hex(''), 'the timed-out attempt answered with no bytes');
    assert.equal(timedOut.lcmSummary, undefined, 'no summary was written, so the record describes none');

    // Z1: a returned failure also has no `error`, so "wrote" is read from the record's own summary,
    // not from the absence of an error.
    const wrote = summaries.filter((s) => s.lcmSummary !== undefined);
    assert.ok(wrote.length >= 1, 'the retry produced a summary');
    for (const record of wrote) {
      assert.ok(record.lcmSummary, 'a successful summary record says what it covered and cost');
      assert.equal(record.lcmSummary.level, 0);
    }

    // Every record names the session's own call, and the retried attempt and its successor are two
    // calls, not one written twice.
    assert.equal(new Set(summaries).size, summaries.length);
    const summaryCalls = exchanges.filter((e) => exchangeKind(e) === 'summary');
    assert.equal(summaryCalls.length, attempts, 'the adapter ledger saw every attempt');

    assertBijection(surfaces, exchanges);

    // Z6: the failed attempt is not only in the bundle. The engine's own failures reach the
    // dispatcher and are written into the run's transcript — through the real engine and the real
    // injector, not a stand-in. A stub can show the dispatcher formats a list it was handed; only
    // the real wiring shows the list is filled.
    const transcript = await readFile(path.join(repo, '.maf', 'transcripts', `${runId}.jsonl`), 'utf8');
    const failedLines = transcript.split('\n').filter((line) => line.includes('[surface] lcm summary (failed)'));
    assert.equal(failedLines.length, 1, 'the one failed summary attempt has one transcript line');
    const entry = JSON.parse(failedLines[0]!) as { role: string; metadata: Record<string, unknown> };
    assert.equal(entry.role, 'system');
    assert.equal(entry.metadata.kind, 'lcm-summary');
    assert.equal(entry.metadata.failed, true);
    assert.match(failedLines[0]!, /adapter returned a failure/,
      'the adapter returned this result; the line says so rather than calling it a throw');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A summarization backend whose attempts are scripted one by one: an `AdapterInvokeResult` it
 * returns, or an `Error` it throws. Every attempt is pushed to the exchange ledger exactly as the
 * adapter took it — a throw answered nothing, a returned failure answered the bytes it returned.
 */
class SummaryAnswers extends ScriptedAdapter {
  private attempts = 0;
  private readonly answers: Array<AdapterInvokeResult | Error> = [];

  answer(...answers: Array<AdapterInvokeResult | Error>): this {
    this.answers.push(...answers);
    return this;
  }

  override async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    if (!(o.systemPrompt ?? '').startsWith('You are a context summarization agent')) return super.invoke(o);
    this.attempts += 1;
    const exchange: ScriptedExchange = {
      via: 'invoke', kind: 'task', systemPrompt: o.systemPrompt ?? '', prompt: o.prompt, tools: o.tools ?? [],
    };
    this.exchanges.push(exchange);
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) {
      exchange.output = next.output;
      return next;
    }
    exchange.output = `Summary ${this.attempts}: the run read sum.js and fixed the subtraction.`;
    return answered(exchange.output);
  }

  get summaryAttempts(): number { return this.attempts; }
}

test('Z1: the same adapter result records the same error/outputSha256 shape at the planner and the summarizer', needsLcm, async () => {
  // The adapter *returns* a transport failure in both runs: `success: false` with `output: ''`. The
  // planner's call site records its output digest and no `error` (run.ts); the summarizer must too.
  const plannerRoot = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z1-plan-'));
  const summarizerRoot = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z1-sum-'));
  try {
    const plannerRepo = await dirtyUserRepo(plannerRoot);
    const plannerScripted = new ScriptedCalls([onePlannedNode(TASK), CODER]);
    plannerScripted.planner(transportFailure(), answered(PLAN_TEXT));
    const plannerRun = await runAndRead(plannerRepo, plannerScripted, []);
    const plannerFailed = plannerRun.surfaces.filter(
      (s) => s.kind === 'planner' && s.outputSha256 === sha256Hex(''),
    );
    assert.ok(plannerFailed.length >= 1, 'the returned planning failure is recorded');

    const summarizerRepo = await compactingRepo(summarizerRoot);
    const summarizerScripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    summarizerScripted.answer(transportFailure());
    const summarizerRun = await runAndRead(summarizerRepo, summarizerScripted, []);
    const summarizerFailed = summarizerRun.surfaces.filter(
      (s) => s.kind === 'lcm-summary' && s.outputSha256 === sha256Hex(''),
    );
    assert.equal(summarizerFailed.length, 1, 'the returned summary failure is recorded once');

    const shape = (s: ModelSurfaceRecord) => ({
      error: s.error, outputSha256: s.outputSha256, surfaceSource: s.surfaceSource,
    });
    assert.deepEqual(
      shape(summarizerFailed[0]!), shape(plannerFailed[0]!),
      'a returned failure is one shape whichever call site recorded it (Z1)',
    );
    assert.equal(summarizerFailed[0]!.error, undefined);
  } finally {
    await rm(plannerRoot, { recursive: true, force: true });
    await rm(summarizerRoot, { recursive: true, force: true });
  }
});

test('Z2: a summary failure keeps the surface the adapter attached, not the summarizer\'s fallback', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-attached-'));
  try {
    const repo = await compactingRepo(root);
    const attached = {
      systemPromptSha256: 'a'.repeat(64),
      toolCatalog: 'the backend\'s catalogue',
      promptSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      argv: ['claude', '-p', '--', '<elided 4096 bytes>'],
    };
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(withModelSurface(new TransportError('the backend timed out'), attached));
    const { surfaces, run } = await runAndRead(repo, scripted, []);

    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the failed attempt is recorded');
    const record = failed[0]!;
    assert.equal(record.systemPromptSha256, attached.systemPromptSha256,
      'the system block the adapter actually sent, not the summarizer\'s role prompt');
    assert.equal(record.promptSha256, attached.promptSha256);
    assert.equal(record.outputSha256, attached.outputSha256);
    assert.equal(record.toolCatalog, attached.toolCatalog);
    assert.deepEqual(record.argv, attached.argv);
    assert.equal(record.surfaceSource, undefined, 'the adapter reported this surface; nothing was rebuilt');
    assert.equal(run.error, undefined, 'the retried attempt produced the summary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: a failure before the adapter sent anything records `not-sent`, not `thrown`', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-notsent-'));
  try {
    const repo = await compactingRepo(root);
    const sent = {
      systemPromptSha256: 'd'.repeat(64), toolCatalog: '', promptSha256: 'e'.repeat(64), argv: [],
    };
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(withModelSurface(new Error('the backend binary could not be started'), sent, false));
    const { surfaces } = await runAndRead(repo, scripted, []);

    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the attempt is recorded, once');
    assert.equal(failed[0]!.error, 'not-sent', 'no request left the adapter (R4-L2)');
    assert.equal(failed[0]!.outputSha256, undefined, 'nothing came back');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: a summary the adapter answered with a failure result records its output digest and no `error`', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-exit-'));
  try {
    const repo = await compactingRepo(root);
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(answered('the backend refused the request', false));
    const { surfaces, run } = await runAndRead(repo, scripted, []);

    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.error, undefined, 'a returned result, even a failed one, is not `thrown` (Z1)');
    assert.equal(failed[0]!.outputSha256, sha256Hex('the backend refused the request'));
    assert.equal(run.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: an empty summary is a recorded failure, not a summary of nothing', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-empty-'));
  try {
    const repo = await compactingRepo(root);
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(answered('', true));
    const { surfaces, run } = await runAndRead(repo, scripted, []);

    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'an empty answer is one recorded attempt');
    assert.equal(failed[0]!.error, undefined, 'the adapter returned; the emptiness is the failure, not a throw');
    assert.equal(failed[0]!.outputSha256, sha256Hex(''), 'the bytes it answered are the evidence');
    assert.equal(surfaces.filter((s) => s.lcmSummary !== undefined).length, 0,
      'no empty summary was written over the messages it was asked to preserve');
    assert.equal(run.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: a transport error the adapter throws is retried, and the retry writes the summary', needsLcm, async () => {
  // B8: the other transport-failure shape. A backend can *throw* its timeout instead of returning
  // a `transportError` result. D-06 retries it once, so a compacting run makes two summary calls
  // and the second produces the summary; the run does not degrade. A catch that wraps the thrown
  // `TransportError` as a plain `Error` loses the retry — one call, no summary, a degraded run.
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-thrown-'));
  try {
    const repo = await compactingRepo(root);
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(new TransportError('the backend timed out'));
    const { surfaces, bundleText, run } = await runAndRead(repo, scripted, []);

    assert.equal(scripted.summaryAttempts, 2, 'the thrown transport failure was retried once (D-06)');
    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the thrown attempt is recorded, once');
    assert.equal(failed[0]!.error, 'thrown', 'the adapter threw: no result came back');
    assert.equal(failed[0]!.surfaceSource, 'fallback',
      'nothing was attached to the throw; the summarizer built the surface it meant to send');
    const wrote = surfaces.filter((s) => s.lcmSummary !== undefined);
    assert.equal(wrote.length, 1, 'the second attempt wrote the summary the compaction needed');
    const predicate = (JSON.parse(bundleText) as InTotoStatement<AttestationBundle>).predicate;
    assert.equal(predicate.lcmDegraded?.length ?? 0, 0, 'the retry succeeded, so nothing degraded');
    assert.equal(run.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: a returned summary failure keeps the surface the adapter reported, not the fallback', needsLcm, async () => {
  // B7: the returned-failure path. The adapter answered and reported the surface it actually sent
  // (its argv); the record must keep it and must not mark the surface as rebuilt. The throw-path
  // test above covers the other shape. Replacing `attached ?? sent` with `sent` on this path swaps
  // the adapter's argv for an empty one the summarizer guessed, and marks it `fallback`.
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-returned-attached-'));
  try {
    const repo = await compactingRepo(root);
    const attached = {
      systemPromptSha256: 'f'.repeat(64),
      toolCatalog: 'the backend\'s catalogue',
      promptSha256: '1'.repeat(64),
      outputSha256: '2'.repeat(64),
      argv: ['claude', '-p', '--', 'the backend\'s own argv'],
    };
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer({ ...answered('the backend refused the request', false), modelSurface: attached });
    const { surfaces, run } = await runAndRead(repo, scripted, []);

    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the returned failure is recorded, once');
    const record = failed[0]!;
    assert.equal(record.systemPromptSha256, attached.systemPromptSha256,
      'the system block the adapter actually sent');
    assert.equal(record.promptSha256, attached.promptSha256);
    assert.equal(record.outputSha256, attached.outputSha256);
    assert.equal(record.toolCatalog, attached.toolCatalog);
    assert.deepEqual(record.argv, attached.argv, 'the adapter\'s own argv, not the fallback\'s empty one');
    assert.equal(record.surfaceSource, undefined, 'the adapter reported this surface; nothing was rebuilt');
    assert.equal(record.error, undefined, 'the adapter returned a failed result (Z1)');
    assert.equal(run.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Z2: an Agentic-Map sub-agent that throws is recorded once, with its attached surface', needsLcm, async () => {
  // B15: Agentic-Map's summary call is made by a sub-agent, not by the engine directly. When that
  // sub-agent throws, the failure must still reach `recordSummaryCall` — once, with the surface
  // the throw carried. If the sub-agent's catch drops the surface, the engine has nothing to
  // record and the attempt disappears from the bundle.
  const root = await mkdtemp(path.join(tmpdir(), 'maf-surfaces-z2-agentic-'));
  try {
    const repo = await compactingRepo(root, 'agentic-map');
    const attached = {
      systemPromptSha256: '3'.repeat(64),
      toolCatalog: 'the sub-agent\'s catalogue',
      promptSha256: '4'.repeat(64),
      argv: ['claude', '-p', '--', 'agentic-map argv'],
    };
    const scripted = new SummaryAnswers([onePlannedNode(TASK), CODER]);
    scripted.answer(withModelSurface(new TransportError('the sub-agent timed out'), attached));
    const { surfaces, run } = await runAndRead(repo, scripted, []);

    assert.equal(scripted.summaryAttempts, 2, 'the sub-agent\'s transport failure was retried (D-06)');
    const failed = surfaces.filter((s) => s.kind === 'lcm-summary' && s.lcmSummary === undefined);
    assert.equal(failed.length, 1, 'the Agentic-Map failure is recorded exactly once');
    assert.equal(failed[0]!.error, 'thrown');
    assert.deepEqual(failed[0]!.argv, attached.argv, 'the surface the sub-agent reported');
    assert.equal(surfaces.filter((s) => s.lcmSummary !== undefined).length, 1,
      'the retry produced the summary');
    assert.equal(run.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
