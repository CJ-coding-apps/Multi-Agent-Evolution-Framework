import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { readAsset } from '../assets.js';
import { initFiles } from '../commands/init.js';
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
    assert.equal(bundle.policyInForce?.sourceKind, 'built-in');
    assert.equal('source' in (bundle.policyInForce ?? {}), false, 'the built-in policy has no user path');
    // F5/F9(d): the digest is the shipped asset's, so a reader knows which text actually applied
    // even though no file on disk was read.
    assert.equal(
      bundle.policyInForce?.sha256,
      crypto.createHash('sha256').update(await readAsset('policy.yaml'), 'utf8').digest('hex'),
    );
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
    assert.equal(bundle.policyInForce?.sourceKind, 'none');
    assert.equal(bundle.policyInForce?.ruleCount, 0);
    assert.equal('source' in (bundle.policyInForce ?? {}), false);
    assert.equal('sha256' in (bundle.policyInForce ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('with a .maf/policy.yaml, the record names the file, its kind and the digest of the bytes read', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-file-'));
  try {
    const repo = await dirtyUserRepo(root);
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    const text = await readAsset('policy.yaml');
    await writeFile(path.join(repo, '.maf', 'policy.yaml'), text, 'utf8');

    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }],
      final: 'Fixed sum.js.',
    }]), []);
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

    const force = await bundleFrom(repo, run.out);
    // 0.4.0's field keeps its meaning: the path. The kind is the additive field (F5).
    assert.equal(force.policyInForce?.source, path.join(repo, '.maf', 'policy.yaml'));
    assert.equal(force.policyInForce?.sourceKind, 'file');
    assert.equal(force.policyInForce?.sha256, crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ORACLE (F4). D-49's fallback is for the flag that was never typed. A path the user typed is a
// statement about which file they mean, and a misspelt one must not become "no rules": that is the
// fail-open the whole decision closes. Only `.maf/policy.yaml` reached through the *default* falls
// back; the same string typed by hand stops the run.

test('a typed --policy path that names no file stops the run, relative or absolute', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-typed-missing-'));
  try {
    const repo = await dirtyUserRepo(root);
    for (const typed of ['missing/policy.yaml', path.join(root, 'no-such-policy.yaml')]) {
      const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK)]), ['--policy', typed]);
      assert.ok(run.error instanceof Error, `a run with --policy ${typed} must stop; it finished: ${run.out}`);
      assert.match(run.error.message, /not found/);
      assert.match(run.error.message, /--policy none/, 'the message says how to run without rules');
      assert.ok(run.error.message.includes(typed), `the message names the path asked for: ${run.error.message}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('spelling out the default path by hand is a typed path, so a missing .maf/policy.yaml stops the run', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-d49-typed-default-'));
  try {
    const repo = await dirtyUserRepo(root);
    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK)]), ['--policy', '.maf/policy.yaml']);
    assert.ok(run.error instanceof Error, `the run must stop; it finished: ${run.out}`);
    assert.match(run.error.message, /not found/);
    assert.match(run.error.message, /--policy none/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ORACLE (F2). With no `roles.yaml`, `run` uses the built-in role set, which is not the one `init`
// writes. The docs said otherwise; the run now says which set it used, in one line, only when that
// is the set it used.

test('with no .maf/roles.yaml, run says it fell back to the built-in role set', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-f2-roles-line-'));
  try {
    const repo = await dirtyUserRepo(root);
    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK, steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed.',
    }]), []);
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.match(run.out, /\[maf\] roles: no \.maf\/roles\.yaml — using the built-in role set \(maf init writes the shipped one\)/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('with a .maf/roles.yaml, run says nothing about the role set', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-f2-roles-present-'));
  try {
    const repo = await dirtyUserRepo(root);
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    // The shipped role set names its prompt files, so every file it names has to exist for a harness
    // mint. Only the prompts are copied: the policy stays absent so the built-in one is in force.
    for (const relative of (await initFiles()).filter((f) => f.startsWith(`prompts${path.sep}`))) {
      const destination = path.join(repo, '.maf', relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readAsset(relative.split(path.sep).join('/')), 'utf8');
    }
    await writeFile(path.join(repo, '.maf', 'roles.yaml'), await readAsset('roles.yaml'), 'utf8');
    const run = await drive(repo, new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK, steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed.',
    }]), []);
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.doesNotMatch(run.out, /using the built-in role set/);
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
