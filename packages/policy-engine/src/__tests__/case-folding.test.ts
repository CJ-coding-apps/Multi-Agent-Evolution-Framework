import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PolicyRule, ToolContext, ToolInput } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { caseInsensitiveFilesystem, PolicyEngine } from '../PolicyEngine.js';
import type { PolicyEngineOptions } from '../PolicyEngine.js';
import { PolicyLoader } from '../PolicyLoader.js';

// HS5: case folding is a property of the *rule's action*, not of the platform. On a volume that
// opens `.ENV` as `.env`, a Deny rule written for `**/.env*` must still see the file the write
// lands in. But an Allow rule or an allow-list is the permitting half, and folding there turns a
// refusal into a permission: a higher-priority `docs/**` Allow would match `DOCS/x.env` and no
// Deny rule below it would ever be consulted. So folding applies to Deny and Escalate only, and
// the platform difference can only ever refuse a call that another platform would have allowed.

const stubGraph = {} as never;
const FS_WRITE = makeToolId('fs.write');

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

function rule(
  id: string,
  priority: number,
  predicate: PolicyRule['predicate'],
  action: PolicyRule['action'],
): PolicyRule {
  return { id, description: '', priority, predicate, action };
}

const deny = (glob: string): PolicyRule =>
  rule('deny', 100, { toolId: FS_WRITE, pathGlob: glob }, { kind: 'Deny', reason: 'no' });

function engineWith(rules: PolicyRule[], options: PolicyEngineOptions): PolicyEngine {
  const engine = new PolicyEngine(stubGraph, options);
  engine.loadRules(rules);
  return engine;
}

const verdictFor = async (
  engine: PolicyEngine,
  declared: string,
  input: ToolInput = { path: declared },
): Promise<string> => (await engine.evaluate(FS_WRITE, input, ctx, [declared])).verdict;

// ─── the platform default ───────────────────────────────────────────────────

test('caseInsensitiveFilesystem names the two platforms whose default volumes fold case', () => {
  assert.equal(caseInsensitiveFilesystem('darwin'), true);
  assert.equal(caseInsensitiveFilesystem('win32'), true);
  assert.equal(caseInsensitiveFilesystem('linux'), false);
  assert.equal(caseInsensitiveFilesystem('freebsd'), false);
});

test('the platform option decides the default: linux does not fold, darwin and win32 do', async () => {
  const rules = [deny('**/.env*')];
  assert.equal(await verdictFor(engineWith(rules, { platform: 'darwin' }), '.ENV'), 'Deny');
  assert.equal(await verdictFor(engineWith(rules, { platform: 'win32' }), '.ENV'), 'Deny');
  assert.equal(
    await verdictFor(engineWith(rules, { platform: 'linux' }), '.ENV'),
    'Allow',
    'on a case-sensitive volume `.ENV` is not `.env`, and allowing it is the platform-faithful answer',
  );
});

test('caseInsensitivePaths overrides the platform in both directions', async () => {
  const rules = [deny('**/.env*')];
  assert.equal(await verdictFor(engineWith(rules, { platform: 'darwin', caseInsensitivePaths: false }), '.ENV'), 'Allow');
  assert.equal(await verdictFor(engineWith(rules, { platform: 'linux', caseInsensitivePaths: true }), '.ENV'), 'Deny');
});

// ─── Deny and Escalate fold ─────────────────────────────────────────────────

test('Deny rules fold, so the spellings of a protected file are the protected file', async () => {
  const engine = engineWith([deny('**/.env*')], { caseInsensitivePaths: true });
  for (const name of ['.env', '.ENV', '.Env.local']) {
    assert.equal(await verdictFor(engine, name), 'Deny', name);
  }

  const locks = engineWith([deny('**/*.lock')], { caseInsensitivePaths: true });
  for (const name of ['Cargo.lock', 'CARGO.LOCK', 'cargo.Lock']) {
    assert.equal(await verdictFor(locks, name), 'Deny', name);
  }

  const mafDir = engineWith([deny('{.maf,.maf/**}')], { caseInsensitivePaths: true });
  for (const name of ['.maf/policy.yaml', '.Maf/policy.yaml', '.MAF/roles.yaml']) {
    assert.equal(await verdictFor(mafDir, name), 'Deny', name);
  }
});

test('Escalate rules fold: an approval is asked for for every spelling of a lock file', async () => {
  const engine = engineWith(
    [rule('protect-lock-files', 95, { toolId: FS_WRITE, pathGlob: '**/*.lock' },
      { kind: 'Escalate', requiresApproval: true })],
    { caseInsensitivePaths: true },
  );
  for (const name of ['Cargo.lock', 'CARGO.LOCK']) {
    assert.equal(await verdictFor(engine, name), 'Escalate', name);
  }
});

// ─── Allow and allowedPathGlobs stay exact (the HS5 half) ──────────────────

test('a higher-priority Allow does not match another spelling, so the Deny below it still fires', async () => {
  // The reported loosening: with folding applied to Allow, `DOCS/.env` matches `docs/**` and the
  // call is allowed — the `.env` Deny rule is never consulted. Exact matching keeps the refusal.
  const engine = engineWith([
    rule('docs-allowed', 200, { toolId: FS_WRITE, pathGlob: 'docs/**' }, { kind: 'Allow' }),
    rule('deny-env', 100, { toolId: FS_WRITE, pathGlob: '**/.env*' }, { kind: 'Deny', reason: 'no' }),
    rule('deny-ts', 100, { toolId: FS_WRITE, pathGlob: '**/*.ts' }, { kind: 'Deny', reason: 'no' }),
  ], { caseInsensitivePaths: true });

  assert.equal(await verdictFor(engine, 'docs/.env'), 'Allow', 'the rule the operator wrote matches it');
  assert.equal(await verdictFor(engine, 'docs/a.ts'), 'Allow');
  for (const upper of ['DOCS/.env', 'DOCS/a.ts']) {
    assert.equal(
      await verdictFor(engine, upper),
      'Deny',
      `${upper}: the upper-case spelling is not the one the Allow names, so the Deny below it decides`,
    );
  }
});

test('allowedPathGlobs stay exact: a case variant falls outside the list and the Deny fires', async () => {
  // The tester rule is "may only write tests". An allow-list is the permitting half of a refusal,
  // so folding it would let `TESTS/x.ts` satisfy a list written for `**/tests/**`.
  const testerRule = rule('tester-write-only-tests', 80, {
    agentRole: 'tester',
    toolId: FS_WRITE,
    allowedPathGlobs: ['**/tests/**', 'docs/**'],
  }, { kind: 'Deny', reason: 'tester role' });
  const engine = engineWith([testerRule], { caseInsensitivePaths: true });
  const tester = { ...ctx, agentRole: 'tester' };

  for (const inside of ['tests/x.ts', 'a/tests/x.ts', 'docs/x.ts']) {
    const decision = await engine.evaluate(FS_WRITE, { path: inside }, tester, [inside]);
    assert.equal(decision.verdict, 'Allow', inside);
  }
  for (const outside of ['TESTS/x.ts', 'a/TESTS/x.ts', 'DOCS/x.ts', 'src/x.ts']) {
    const decision = await engine.evaluate(FS_WRITE, { path: outside }, tester, [outside]);
    assert.equal(decision.verdict, 'Deny', outside);
  }
});

// ─── Unicode form ───────────────────────────────────────────────────────────

test('a decomposed name matches a Deny rule written in composed form, and an Allow stays exact', async () => {
  const composed = 'café.lock';                                // é as one code point
  const decomposed = 'café.lock';                             // e + combining acute
  assert.notEqual(composed, decomposed);
  assert.equal(composed.normalize('NFC'), decomposed.normalize('NFC'));

  const denies = engineWith([deny('**/café.lock')], { caseInsensitivePaths: true });
  assert.equal(await verdictFor(denies, decomposed), 'Deny', 'the Deny rule sees the file it names');

  const allows = engineWith([
    rule('allow', 200, { toolId: FS_WRITE, pathGlob: '**/café.lock' }, { kind: 'Allow' }),
    deny('**/café.lock'),
  ], { caseInsensitivePaths: true });
  assert.equal(
    await verdictFor(allows, decomposed),
    'Deny',
    'folding the Allow would permit the spelling it does not name',
  );
});

// ─── HS16: two passes, and the stricter verdict decides ────────────────────

test('HS16: a folded Escalate above a Deny does not lift the Deny on macOS or Windows', async () => {
  // The reported loosening, exactly: `DOCS/x.env` matches the folded `docs/**` Escalate at priority
  // 200, so a single folded pass answers Escalate and never reaches the Deny below it — a refusal
  // nobody can lift became one approval away from permitted. The exact pass finds the Deny.
  const rules = [
    rule('docs-escalate', 200, { toolId: FS_WRITE, pathGlob: 'docs/**' },
      { kind: 'Escalate', requiresApproval: true }),
    rule('deny-dotenv', 100, { toolId: FS_WRITE, pathGlob: '**/*.env*' },
      { kind: 'Deny', reason: 'dotenv files are never written' }),
  ];

  for (const platform of ['darwin', 'win32'] as const) {
    const engine = engineWith(rules, { platform });
    assert.equal(await verdictFor(engine, 'DOCS/x.env'), 'Deny', `${platform}: the stricter verdict wins`);
    // The operator's own spelling is still the escalation the operator wrote.
    assert.equal(await verdictFor(engine, 'docs/x.env'), 'Escalate', platform);
  }

  // The mutant `take the folded verdict only`: with the Deny removed, one folded pass is all that
  // is left, and it answers Escalate for `DOCS/x.env`. A one-pass engine returns this verdict.
  const foldedAlone = engineWith([rules[0]!], { caseInsensitivePaths: true });
  assert.equal(await verdictFor(foldedAlone, 'DOCS/x.env'), 'Escalate');

  // Linux, unchanged: nothing folds, so the spelled-out Deny still decides and `.ENV` is `.ENV`.
  const linux = engineWith(rules, { platform: 'linux' });
  assert.equal(await verdictFor(linux, 'DOCS/x.env'), 'Deny');
  assert.equal(await verdictFor(linux, '.ENV'), 'Allow');
});

test('HS16: Indeterminate is stricter than a folded Escalate, so an unaskable rule still refuses', async () => {
  // `Indeterminate` sits above `Escalate` because an approval lifts an escalation, and there is
  // nothing a human can approve about a rule that could not be asked. The exact pass reaches the
  // unaskable rule; the folded pass would stop at the Escalate above it.
  const broken = new PolicyEngine(
    { run: async (): Promise<never> => { throw new Error('graph is down'); } } as never,
    { caseInsensitivePaths: true },
  );
  broken.loadRules([
    rule('docs-escalate', 200, { toolId: FS_WRITE, pathGlob: 'docs/**' },
      { kind: 'Escalate', requiresApproval: true }),
    rule('unaskable', 100, {
      toolId: FS_WRITE,
      pathGlob: '**/*.env',
      memoryPattern: { cypher: 'MATCH (n) RETURN n' },
    }, { kind: 'Deny', reason: 'no' }),
  ]);
  assert.equal(await verdictFor(broken, 'DOCS/x.env'), 'Indeterminate');
});

test('HS16: the HS5 probes give the same verdicts on the two-pass engine', async () => {
  const rules = [
    rule('docs-allowed', 200, { toolId: FS_WRITE, pathGlob: 'docs/**' }, { kind: 'Allow' }),
    rule('deny-env', 100, { toolId: FS_WRITE, pathGlob: '**/.env*' }, { kind: 'Deny', reason: 'no' }),
    rule('deny-ts', 100, { toolId: FS_WRITE, pathGlob: '**/*.ts' }, { kind: 'Deny', reason: 'no' }),
  ];
  for (const platform of ['darwin', 'win32'] as const) {
    const engine = engineWith(rules, { platform });
    assert.equal(await verdictFor(engine, 'docs/.env'), 'Allow', `${platform} docs/.env`);
    assert.equal(await verdictFor(engine, 'docs/a.ts'), 'Allow', `${platform} docs/a.ts`);
    for (const upper of ['.ENV', 'DOCS/.env', 'DOCS/a.ts']) {
      assert.equal(await verdictFor(engine, upper), 'Deny', `${platform} ${upper}`);
    }
  }
});

// ─── the option reaches the engine through the loader ──────────────────────

async function withPolicy<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-case-'));
  const file = path.join(dir, 'policy.yaml');
  await writeFile(file, body, 'utf8');
  try { return await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

const POLICY = [
  'rules:',
  '  - id: deny-env-files',
  '    description: Never write .env files',
  '    priority: 100',
  '    predicate:',
  '      toolId: [fs.write]',
  '      pathGlob: "**/.env*"',
  '    action:',
  '      kind: Deny',
  '      reason: ".env files must be managed manually"',
  '',
].join('\n');

test('PolicyLoader passes `platform` and `caseInsensitivePaths` through to the engine', async () => {
  await withPolicy(POLICY, async (file) => {
    const linux = await PolicyLoader.loadEngine(file, stubGraph, { platform: 'linux' });
    assert.equal(await verdictFor(linux, '.ENV'), 'Allow');

    const darwin = await PolicyLoader.loadEngine(file, stubGraph, { platform: 'darwin' });
    assert.equal(await verdictFor(darwin, '.ENV'), 'Deny');

    const forced = await PolicyLoader.loadEngine(file, stubGraph, { platform: 'linux', caseInsensitivePaths: true });
    assert.equal(await verdictFor(forced, '.ENV'), 'Deny', 'the explicit option wins over the platform');
  });
});
