import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AttestationBundle, ToolCallRecord } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { InTotoStatement } from '@maf/attestation';
import {
  onePlannedNode, FIXED_SUM, dirtyUserRepo, driveRun, needsLcm, registryOf,
} from './runFixture.js';

// ORACLE (D-49). A repository that has never run `maf init` has no `.maf/policy.yaml`. Before D-49
// `run` then proceeded with no rules, so an installed CLI was silently ungoverned by policy — the
// same class as F11, a shipped default that does not do what the docs imply. Now the shipped policy
// is in force and the record says which of three sources chose it. These drive the real command.

const TASK = 'Fix the bug in sum.js so the test passes';
const KEY = 'd49-signing-key';

/** Runs `fn` with `console.warn` captured: the policy's one line goes there, not to RunIo.stderr. */
async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

function bundleOf(text: string): AttestationBundle {
  return (JSON.parse(text) as InTotoStatement<AttestationBundle>).predicate;
}

/** One planned node that tries to write `.env` before doing the task — the shipped policy's first test. */
function scripted(): ScriptedAdapter {
  return new ScriptedAdapter([onePlannedNode(TASK), {
    prompt: TASK,
    steps: [
      { tool: 'fs.write', input: { path: '.env', content: 'AWS_SECRET_ACCESS_KEY=stolen\n' } },
      { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
    ],
    final: 'Fixed sum.js: a - b → a + b.',
  }]);
}

function drive(repo: string, adapter: ScriptedAdapter, extra: readonly string[] = []) {
  return driveRun([TASK, '--dir', repo, ...extra, '--adapter', 'scripted'], {
    adapters: registryOf(adapter),
    io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: KEY } },
  });
}

async function bundleFrom(repo: string, out: string): Promise<AttestationBundle> {
  const runId = /\[maf\] run (\S+) \|/.exec(out)?.[1];
  assert.ok(runId, out);
  return bundleOf(await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8'));
}

test('with no --policy and no .maf/policy.yaml, run is governed by the built-in policy and records it', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-built-in-'));
  try {
    const repo = await dirtyUserRepo(root);
    const run = await drive(repo, scripted(), []);
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

    const bundle = await bundleFrom(repo, run.out);
    assert.equal(bundle.policyInForce?.source, 'built-in');
    assert.equal('path' in (bundle.policyInForce ?? {}), false, 'the built-in policy has no user path');
    assert.equal('sha256' in (bundle.policyInForce ?? {}), false, 'nothing on disk was read');
    const ids = bundle.policyInForce?.rules.map((r) => r.id) ?? [];
    assert.ok(ids.includes('deny-env-files'), `the shipped rule is in force; got ${ids.join(', ')}`);

    // The rule fired on the real call: `.env` was denied, and the coder's real change went through.
    const writes = bundle.toolCalls.filter((c: ToolCallRecord) => c.toolId === 'fs.write');
    const env = writes.find((c) => c.input['path'] === '.env');
    assert.ok(env, 'the .env write reached the gate');
    assert.equal(env.policyDecision.verdict, 'Deny');
    assert.equal(env.policyDecision.verdict === 'Deny' ? env.policyDecision.ruleId : undefined, 'deny-env-files');
    assert.ok(writes.some((c) => c.input['path'] === 'sum.js' && c.policyDecision.verdict === 'Allow'));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the built-in default prints one line naming it, and nothing else', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-line-'));
  try {
    const repo = await dirtyUserRepo(root);
    let runError: unknown;
    const warnings = await capturingWarnings(async () => {
      const run = await drive(repo, scripted(), []);
      runError = run.error;
    });
    assert.equal(runError, undefined, 'the run itself succeeded');
    assert.equal(warnings.length, 1, `exactly one policy line; got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0]!, /no policy file at .*\.maf[/\\]policy\.yaml/);
    assert.match(warnings[0]!, /using the built-in policy \(\d+ rules\)/);
    assert.match(warnings[0]!, /--policy none/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('--policy none opts out explicitly, runs with no rules, and records source "none"', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-none-'));
  try {
    const repo = await dirtyUserRepo(root);
    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }],
      final: 'Fixed sum.js.',
    }]), ['--policy', 'none']);
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

    const bundle = await bundleFrom(repo, run.out);
    assert.equal(bundle.policyInForce?.source, 'none');
    assert.equal(bundle.policyInForce?.ruleCount, 0);
    assert.equal('path' in (bundle.policyInForce ?? {}), false);
    assert.equal('sha256' in (bundle.policyInForce ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a policy file that exists but is invalid still stops the run, built-in default or not', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-invalid-'));
  try {
    const repo = await dirtyUserRepo(root);
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'policy.yaml'), 'rules:\n  - id: broken\n', 'utf8');

    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK)]), []);
    const error = run.error;
    assert.ok(error instanceof Error, 'the run stopped');
    assert.match(error.message, /failed validation/);
    assert.match(error.message, /\.maf[/\\]policy\.yaml/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
