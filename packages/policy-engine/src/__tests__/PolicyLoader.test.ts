import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PolicyRule, ToolContext } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyLoader } from '../PolicyLoader.js';

// No rule here sets `memoryPattern`, so a typed stub for the graph is sufficient.
const stubGraph = {} as never;

async function withTempFile(content: string, fn: (p: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-policy-'));
  const file = path.join(dir, 'policy.yaml');
  await writeFile(file, content, 'utf8');
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** `assert.rejects`, with every pattern matched against the one error's message. */
async function rejectsWith(promise: Promise<unknown>, ...patterns: RegExp[]): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, 'an Error is thrown');
    for (const pattern of patterns) assert.match(err.message, pattern);
    return true;
  });
}

/** Runs `fn` with `console.warn` captured, one entry per call, and restores it afterwards. */
async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

const ctx: ToolContext = {
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('r1'),
  taskId:      makeTaskId('t1'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined } as never,
};

const FS_WRITE = makeToolId('fs.write');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('load() reads a real YAML policy: block style, comments, quoted globs and flow lists', async () => {
  // The format the file is named for. The parser this replaced only understood JSON, so this
  // document loaded zero rules — every Deny and Escalate gone, silently.
  const doc = [
    '# a policy written the way a person writes YAML',
    'rules:',
    '  - id: deny-env',
    '    description: never write env files',
    '    priority: 100',
    '    predicate:',
    '      toolId: [fs.write, patch.apply]',
    '      pathGlob: "**/.env*"',
    '    action:',
    '      kind: Deny',
    '      reason: env files are managed by hand',
    '      alternative: fs.read',
    '',
    '  # description is optional: it never changes a verdict',
    '  - id: lockfiles',
    '    priority: 90',
    '    predicate:',
    '      agentRole: coder',
    '      allowedPathGlobs:',
    '        - "src/**"',
    '      memoryPattern:',
    '        cypher: "MATCH (f {path: $path}) RETURN f"',
    '      minFailureCount: 2',
    '    action: { kind: Escalate, requiresApproval: true }',
    '',
    '  - id: open',
    '    priority: 1',
    '    predicate: {}',
    '    action: { kind: Allow }',
  ].join('\n');
  await withTempFile(doc, async (file) => {
    const rules = await PolicyLoader.load(file);
    const expected: PolicyRule[] = [
      {
        id: 'deny-env', description: 'never write env files', priority: 100,
        predicate: { toolId: [FS_WRITE, makeToolId('patch.apply')], pathGlob: '**/.env*' },
        action: { kind: 'Deny', reason: 'env files are managed by hand', alternative: makeToolId('fs.read') },
      },
      {
        id: 'lockfiles', description: '', priority: 90,
        predicate: {
          agentRole: 'coder',
          allowedPathGlobs: ['src/**'],
          memoryPattern: { cypher: 'MATCH (f {path: $path}) RETURN f' },
          minFailureCount: 2,
        },
        action: { kind: 'Escalate', requiresApproval: true },
      },
      { id: 'open', description: '', priority: 1, predicate: {}, action: { kind: 'Allow' } },
    ];
    assert.deepEqual(rules, expected);
  });
});

test('load() parses JSON-formatted policy files (JSON is valid YAML)', async () => {
  const doc = JSON.stringify({
    rules: [{
      id: 'r1', description: 'd', priority: 10,
      predicate: { toolId: 'fs.write' },
      action: { kind: 'Deny', reason: 'no' },
    }],
  });
  await withTempFile(doc, async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.id, 'r1');
    assert.equal(rules[0]?.action.kind, 'Deny');
  });
});

test('load() accepts # comment lines around a JSON document, as YAML comments', async () => {
  const doc = [
    '# maf policy file',
    '  # another comment',
    JSON.stringify({ rules: [{ id: 'c1', description: '', priority: 1, predicate: {}, action: { kind: 'Allow' } }] }),
  ].join('\n');
  await withTempFile(doc, async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.id, 'c1');
  });
});

test('load() logs exactly one warning line for a missing file and returns no rules', async () => {
  const missing = '/nonexistent/definitely/policy.yaml';
  let rules: PolicyRule[] | undefined;
  const lines = await capturingWarnings(async () => { rules = await PolicyLoader.load(missing); });

  assert.deepEqual(rules, []);
  assert.equal(lines.length, 1, `expected one warning, got ${JSON.stringify(lines)}`);
  assert.ok(!(lines[0] ?? '').includes('\n'), 'the warning is a single line');
  assert.ok((lines[0] ?? '').includes(missing), 'the warning names the path it looked for');
});

test('load() takes an explicit empty rule list at its word, without a warning', async () => {
  // Zero rules written on purpose is not zero rules from a failure: nothing to warn about.
  await withTempFile('rules: []\n', async (file) => {
    let rules: PolicyRule[] | undefined;
    const lines = await capturingWarnings(async () => { rules = await PolicyLoader.load(file); });
    assert.deepEqual(rules, []);
    assert.deepEqual(lines, []);
  });
});

test('load() refuses a file that is not YAML, and the error carries the parse error', async () => {
  // This replaces "returns [] for unparseable content rather than throwing" — the defect stated
  // as a test. A JSON typo must stop the run, not remove the policy.
  await withTempFile('{ "rules": [ { "id": "a" }', async (file) => {
    // The file is named, and the parser's own location is kept.
    await rejectsWith(PolicyLoader.load(file), /is not valid YAML/, new RegExp(escapeRegExp(file)), /line 1, column/);
  });
});

test('load() refuses a duplicated key instead of letting the second one win', async () => {
  await withTempFile('rules:\n  - id: a\n    priority: 1\n    predicate: {}\n    action: { kind: Allow }\nrules: []\n', async (file) => {
    await assert.rejects(PolicyLoader.load(file), /is not valid YAML[\s\S]*unique/);
  });
});

test('load() refuses an unquoted glob, which YAML reads as an alias', async () => {
  // The likeliest mistake a person converting the shipped JSON will make.
  const doc = 'rules:\n  - id: g\n    priority: 1\n    predicate:\n      pathGlob: **/.env*\n    action: { kind: Deny, reason: no }\n';
  await withTempFile(doc, async (file) => {
    await assert.rejects(PolicyLoader.load(file), /is not valid YAML[\s\S]*alias/);
  });
});

test('load() refuses an empty or comment-only file rather than reading it as no rules', async () => {
  for (const content of ['', '# nothing here yet\n']) {
    await withTempFile(content, async (file) => {
      await assert.rejects(PolicyLoader.load(file), /failed validation[\s\S]*empty or holds only comments/);
    });
  }
});

test('load() refuses a document with no rules list', async () => {
  // This replaces "returns [] when document has no rules key".
  await withTempFile(JSON.stringify({ other: true }), async (file) => {
    await rejectsWith(
      PolicyLoader.load(file),
      /failed validation/, /The policy has unknown field "other"/, /The policy is missing rules/,
    );
  });
});

test('load() refuses an unknown verdict kind, naming the rule and the kind', async () => {
  const doc = 'rules:\n  - id: blocker\n    priority: 5\n    predicate: { toolId: fs.write }\n    action: { kind: Block, reason: no }\n';
  await withTempFile(doc, async (file) => {
    await assert.rejects(
      PolicyLoader.load(file),
      /rules\[0\] \("blocker"\): action\.kind must be one of "Allow", "Deny" or "Escalate"; found "Block"/,
    );
  });
});

test('load() refuses a rule missing a required field, for each required field', async () => {
  const complete = {
    id: 'r', priority: 1, predicate: { toolId: 'fs.write' }, action: { kind: 'Deny', reason: 'no' },
  };
  for (const field of ['id', 'priority', 'predicate', 'action']) {
    const rule: Record<string, unknown> = { ...complete };
    delete rule[field];
    await withTempFile(JSON.stringify({ rules: [rule] }), async (file) => {
      await assert.rejects(PolicyLoader.load(file), new RegExp(`is missing ${field}:`), field);
    });
  }
  // Each action kind's own required field.
  for (const action of [{ kind: 'Deny' }, { kind: 'Escalate' }]) {
    await withTempFile(JSON.stringify({ rules: [{ ...complete, action }] }), async (file) => {
      await assert.rejects(PolicyLoader.load(file), /is missing action\.(reason|requiresApproval):/, action.kind);
    });
  }
});

test('load() refuses fields that would silently widen or disable a rule, and reports them all', async () => {
  const doc = JSON.stringify({
    rules: [
      // A misspelt role field: ignored, it would have made this Allow apply to every role.
      { id: 'typo', priority: 1, predicate: { agentrole: 'tester' }, action: { kind: 'Allow' } },
      // An empty tool list matches no tool, so this Deny would never fire.
      { id: 'dead', priority: 1, predicate: { toolId: [] }, action: { kind: 'Deny', reason: 'x' } },
      // An empty glob means "no path condition" to the engine: every path.
      { id: 'wide', priority: 1, predicate: { pathGlob: '' }, action: { kind: 'Allow' } },
      { id: 'nan', priority: '10', predicate: {}, action: { kind: 'Allow' } },
      { id: 'typo', priority: 2, predicate: {}, action: { kind: 'Allow' } },
    ],
  });
  await withTempFile(doc, async (file) => {
    await rejectsWith(
      PolicyLoader.load(file),
      /rules\[0\] \("typo"\) predicate has unknown field "agentrole"/,
      /rules\[1\] \("dead"\): predicate\.toolId must be .*; found an empty list/,
      /rules\[2\] \("wide"\): predicate\.pathGlob must be a non-empty glob; found an empty string/,
      /rules\[3\] \("nan"\): priority must be a finite number; found "10"/,
      /rules\[4\] \("typo"\): id is already used by rules\[0\]/,
    );
  });
});

test('load() refuses a YAML .nan priority, which would make the priority order meaningless', async () => {
  const doc = 'rules:\n  - id: n\n    priority: .nan\n    predicate: {}\n    action: { kind: Allow }\n';
  await withTempFile(doc, async (file) => {
    await assert.rejects(PolicyLoader.load(file), /priority must be a finite number; found NaN/);
  });
});

test('load() refuses a policy path that exists but cannot be read as a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-policy-'));
  try {
    // A directory where the file should be.
    await assert.rejects(PolicyLoader.load(dir), /exists but could not be read/);

    // A dangling symlink: its name exists, the policy it pointed at does not.
    const link = path.join(dir, 'policy.yaml');
    await symlink(path.join(dir, 'gone.yaml'), link);
    let rejected = false;
    const lines = await capturingWarnings(async () => {
      await assert.rejects(PolicyLoader.load(link), /exists but could not be read/);
      rejected = true;
    });
    assert.ok(rejected);
    assert.deepEqual(lines, [], 'a refusal is not also reported as a missing file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadEngine() returns an engine that enforces the file\'s rules', async () => {
  const doc = '# generated policy\nrules:\n  - id: from-file\n    priority: 10\n    predicate: { toolId: fs.write }\n    action: { kind: Deny, reason: from file }\n';
  await withTempFile(doc, async (file) => {
    const engine = await PolicyLoader.loadEngine(file, stubGraph);
    const res = await engine.evaluate(FS_WRITE, { path: 'x' }, ctx, ['x']);
    assert.equal(res.verdict, 'Deny');
    assert.equal(res.verdict === 'Deny' ? res.reason : '', 'from file');
  });
});

// D-49 replaces this as the *run* default: `run` now supplies `builtInText`, so a missing
// .maf/policy.yaml is governed by the shipped policy (see the tests below). The raw loader keeps
// "no file, no rules" for callers that deliberately pass nothing — goldens and evolve do.
test('loadEngine() without built-in text still warns once and allows when the file is missing', async () => {
  let verdict: string | undefined;
  const lines = await capturingWarnings(async () => {
    const engine = await PolicyLoader.loadEngine('/no/such/policy.yaml', stubGraph);
    verdict = (await engine.evaluate(FS_WRITE, { path: 'x' }, ctx, ['x'])).verdict;
  });
  assert.equal(verdict, 'Allow');
  assert.equal(lines.length, 1);
});

test('loadEngine() refuses to build an engine from a file that fails validation', async () => {
  await withTempFile('rules:\n  - id: x\n', async (file) => {
    await assert.rejects(PolicyLoader.loadEngine(file, stubGraph), /failed validation/);
  });
});

test('validate() passes well-formed rules', () => {
  const rules: PolicyRule[] = [{
    id: 'ok', description: '', priority: 5,
    predicate: { toolId: 'fs.write' as never },
    action: { kind: 'Allow' },
  }];
  assert.deepEqual(PolicyLoader.validate(rules), []);
});

test('validate() reports missing id, action.kind, and predicate', () => {
  const bad = [
    { description: '', priority: 1, predicate: {}, action: { kind: 'Allow' } },      // no id
    { id: 'no-action', description: '', priority: 1, predicate: {}, action: {} },    // no action.kind
    { id: 'no-pred', description: '', priority: 1, action: { kind: 'Allow' } },      // no predicate
  ] as unknown as PolicyRule[];
  const errors = PolicyLoader.validate(bad);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /missing id/i.test(e)));
  assert.ok(errors.some((e) => /no-action.*action\.kind/i.test(e)));
  assert.ok(errors.some((e) => /no-pred.*predicate/i.test(e)));
});

test('validate() refuses something that is not a list of rules', () => {
  assert.deepEqual(PolicyLoader.validate({ rules: [] }), ['Expected a list of rules; found a mapping.']);
});

// ORACLE (F6 of the 0.3.1 sweep). `loadWithSource` returns the sha256 of the bytes it read, so a
// bundle can name the policy by digest. The digest is absent exactly when no file was read — which
// is what lets a reader tell "no policy file" from "a file whose rules never matched".

test('loadWithSource returns the sha256 of the bytes it read, and the parsed rules', async () => {
  const text = 'rules:\n  - id: protect-secrets\n    priority: 100\n    predicate: { pathGlob: ".env" }\n    action: { kind: Deny, reason: "no secrets" }\n';
  await withTempFile(text, async (file) => {
    const { rules, sha256 } = await PolicyLoader.loadWithSource(file);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.id, 'protect-secrets');
    assert.equal(sha256, createHash('sha256').update(text, 'utf8').digest('hex'), 'the digest is of the file bytes');
  });
});

test('loadWithSource omits the sha256 when no policy file was read, so an absent file is not an empty one', async () => {
  const warnings = await capturingWarnings(async () => {
    const { rules, sha256 } = await PolicyLoader.loadWithSource('/tmp/maf-does-not-exist-policy.yaml');
    assert.deepEqual(rules, [], 'running with no policy is a posture MAF supports');
    assert.equal(sha256, undefined, 'there were no bytes to digest');
  });
  assert.equal(warnings.length, 1, 'and the absence is said once');
});

// ORACLE (F6). The bundle's policy record depends on `loadEngine` handing the source and its digest to
// the engine it returns — the last hop before `inForce()`. `loadWithSource` is pinned above; this pins
// the wiring, so a `run` whose policy file was read cannot report a source with no digest.

test('loadEngine wires the source and its digest onto the engine that inForce() reads', async () => {
  const text = 'rules:\n  - id: protect-secrets\n    priority: 100\n    predicate: { pathGlob: ".env" }\n    action: { kind: Deny, reason: "no secrets" }\n';
  await withTempFile(text, async (file) => {
    const force = (await PolicyLoader.loadEngine(file, stubGraph)).inForce();
    assert.equal(force.source, 'file', 'the rules came from a file');
    assert.equal(force.path, file, 'and this is the file');
    assert.equal(force.sha256, createHash('sha256').update(text, 'utf8').digest('hex'), 'digested from the bytes it read');
    assert.equal(force.ruleCount, 1);
  });
});

test('loadEngine names a missing policy file on the record but no digest, so a reader is not told one was read', async () => {
  const warnings = await capturingWarnings(async () => {
    const force = (await PolicyLoader.loadEngine('/tmp/maf-does-not-exist-policy.yaml', stubGraph)).inForce();
    assert.equal(force.source, 'file', 'a file was asked for');
    assert.equal(force.path, '/tmp/maf-does-not-exist-policy.yaml', 'the path asked for is named');
    assert.equal('sha256' in force, false, 'no bytes were read, so there is no digest');
    assert.equal(force.ruleCount, 0);
  });
  assert.equal(warnings.length, 1, 'and the absence is said once');
});

// ORACLE (D-49). An installed `maf` must govern a repository that has never run `maf init`: with no
// policy named and no file at the default path, the shipped policy applies. The record has to say so,
// because a run under the built-in policy and a run with no policy at all are different postures.

const BUILT_IN = 'rules:\n  - id: built-in-deny\n    priority: 100\n    predicate: { pathGlob: ".env" }\n    action: { kind: Deny, reason: "no secrets" }\n';

test('a missing file runs under the built-in policy when one is supplied, and says so in one line', async () => {
  const warnings = await capturingWarnings(async () => {
    const force = (await PolicyLoader.loadEngine('/tmp/maf-does-not-exist-policy.yaml', stubGraph, {
      builtInText: BUILT_IN,
    })).inForce();
    assert.equal(force.source, 'built-in');
    assert.equal('path' in force, false, 'no user file was named');
    assert.equal('sha256' in force, false, 'nothing on disk was read');
    assert.equal(force.ruleCount, 1);
    assert.deepEqual(force.rules.map((r) => r.id), ['built-in-deny']);
  });
  assert.equal(warnings.length, 1, 'one line, not the old absence line plus a second');
  assert.match(warnings[0]!, /using the built-in policy \(1 rule\)/);
  assert.match(warnings[0]!, /--policy none/);
});

test('a policy file that exists wins over the built-in default', async () => {
  await withTempFile('rules: []\n', async (file) => {
    const force = (await PolicyLoader.loadEngine(file, stubGraph, { builtInText: BUILT_IN })).inForce();
    assert.equal(force.source, 'file');
    assert.equal(force.path, file);
    assert.equal(force.sha256, createHash('sha256').update('rules: []\n', 'utf8').digest('hex'));
    assert.equal(force.ruleCount, 0, 'the user file was read, not the built-in one');
  });
});

test('a file that exists but does not load still stops the run, built-in text or not', async () => {
  await withTempFile('rules: [ { bogus: true } ]\n', async (file) => {
    await rejectsWith(PolicyLoader.loadEngine(file, stubGraph, { builtInText: BUILT_IN }), /failed validation/);
  });
});

test('--policy none runs with no rules and records that choice, even when a file exists', async () => {
  await withTempFile(BUILT_IN, async (file) => {
    const warnings = await capturingWarnings(async () => {
      const force = (await PolicyLoader.loadEngine(file, stubGraph, { none: true })).inForce();
      assert.equal(force.source, 'none');
      assert.equal('path' in force, false);
      assert.equal('sha256' in force, false);
      assert.equal(force.ruleCount, 0);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--policy none/);
  });
});
