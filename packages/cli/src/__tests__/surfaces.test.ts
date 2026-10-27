import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type {
  AdapterInvokeOptions, AssistantTurn, AttestationBundle, ModelSurfaceRecord, TurnMessage,
} from '@maf/types';
import { sha256Hex } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { ScriptedExchange } from '@maf/eval-harness';
import { Attestor, MAF_RUN_PREDICATE_TYPE, parseBundle } from '@maf/attestation';
import type { InTotoStatement } from '@maf/attestation';
import {
  FIXED_SUM, dirtyUserRepo, driveRun, needsLcm, registryOf,
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

type ExchangeKind = 'role-turn' | 'summary' | 'planner' | 'security-gate' | 'other';

/**
 * Which model call an exchange was, read from the prompt alone — the same way an operator reading
 * the transcript would. A summary call is `@maf/lcm`'s (WP-3.2); there is none on this branch, but
 * the matcher names it so the rebase onto that lane does not silently stop covering it.
 */
function exchangeKind(e: ScriptedExchange): ExchangeKind {
  if (e.via === 'turn') return 'role-turn';
  if (/^Create a task execution DAG for:/.test(e.prompt)) return 'planner';
  if (/^Audit (this diff|these files) for security issues\./.test(e.prompt)) return 'security-gate';
  if (e.systemPrompt.startsWith('You are a context summarization agent')) return 'summary';
  return 'other';
}

/** A surface record's kind as the exchange's word for it: absent is a role call (it predates the field). */
function surfaceKind(s: ModelSurfaceRecord): ExchangeKind {
  // Read through `string` so this file compiles both before and after the LCM-lane rebase, where
  // `'lcm-summary'` joins the union.
  const kind = s.kind as string | undefined;
  if (kind === undefined || kind === 'role-call') return 'role-turn';
  if (kind === 'lcm-summary') return 'summary';
  return kind as ExchangeKind;
}

/** The digest key a surface record is matched by. An in-process turn has no prompt/output digest. */
function surfaceKey(s: ModelSurfaceRecord): string {
  return `${s.systemPromptSha256}|${s.promptSha256 ?? ''}|${s.outputSha256 ?? ''}`;
}

/** The same key, computed from what the adapter was handed and answered. */
function exchangeKey(e: ScriptedExchange): string {
  if (e.via === 'turn') return `${sha256Hex(e.systemPrompt)}||`;
  return `${sha256Hex(e.systemPrompt)}|${sha256Hex(e.prompt)}|${sha256Hex(e.output ?? '')}`;
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
    const turns = surfaces.filter((s) => s.kind === undefined);
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
