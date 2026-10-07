import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyRule } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';
import { ViolationHandler } from '../ViolationHandler.js';

// ORACLE (D-11: "`**/.env*` denies `.env` but allows `../.env`";
// A2-4 "used by both the tools and the policy glob matcher, so the
// checked path and the executed path are the same value").
//
// The tool half of that guarantee is asserted in `@maf/tools`. This is the half a model actually
// meets: `executeToolGated` asks the engine first, so the engine's answer is what stops the call.

// No test here sets `memoryPattern`, so a typed stub for the graph is sufficient.
const stubGraph = {} as never;

const baseCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('r1'),
  taskId:      makeTaskId('t1'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined } as never,
  ...overrides,
});

const FS_WRITE = makeToolId('fs.write');

/** The shipped `protect-secrets` rule, from `examples/.maf/policy.yaml`. */
const PROTECT_SECRETS: PolicyRule = {
  id: 'protect-secrets',
  description: '',
  priority: 100,
  predicate: { toolId: [FS_WRITE], pathGlob: '**/.env*' },
  action: { kind: 'Deny', reason: 'secrets are off-limits' },
};

const ALLOWED_PATHS: PolicyRule = {
  id: 'only-tests',
  description: '',
  priority: 100,
  predicate: { toolId: [FS_WRITE], allowedPathGlobs: ['**/tests/**', '**/__tests__/**'] },
  action: { kind: 'Deny', reason: 'writes outside the test tree' },
};

function engineWith(...rules: PolicyRule[]): PolicyEngine {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules(rules);
  return engine;
}

/** What `executeToolGated` passes: the path, and the tool's declaration of that same path. */
function evaluate(engine: PolicyEngine, path: string, declared: string[] = [path]) {
  return engine.evaluate(FS_WRITE, { path }, baseCtx(), declared);
}

test('every spelling of .env is denied by the shipped rule, not only the one the caller chose', async () => {
  // Before the path was resolved, `minimatch` was handed the raw input string: `.env` matched
  // and `./.env` and `a/../.env` did not, so the rule fired or not depending on how the model
  // happened to spell the same file. All three now normalise to the one path the glob is about.
  const engine = engineWith(PROTECT_SECRETS);

  for (const spelling of ['.env', './.env', 'a/../.env', 'sub/../.env', './/.env']) {
    assert.equal((await evaluate(engine, spelling)).verdict, 'Deny', `${JSON.stringify(spelling)}`);
  }
});

test('the same rule still declines to fire on an ordinary file', async () => {
  // The control for the test above: a rule that denied everything would satisfy it equally.
  assert.equal((await evaluate(engineWith(PROTECT_SECRETS), 'src/notes.txt')).verdict, 'Allow');
});

test('a path that leaves the root is refused with no rules loaded at all', async () => {
  // The exit criterion, at the layer that decides. Confinement is not a rule, so an empty policy
  // file — maf's default posture — does not switch it off. The verdict is `Deny` because the path
  // is outside the root, not because a decision could not be reached: this is a refusal, and
  // `ViolationHandler` does not treat it as a question for a human.
  const engine = engineWith();
  const decision = await evaluate(engine, '../outside/.env');

  assert.equal(decision.verdict, 'Deny');
  assert.match(decision.verdict === 'Deny' ? decision.reason : '', /outside the project root/);
  assert.equal(new ViolationHandler().isEscalatable(decision), false);
  assert.throws(() => new ViolationHandler().handle(decision), /Policy violation: Deny/);
});

test('an escaping path is refused even when a rule would have allowed it', async () => {
  // A rule with no path predicate matches every path — and confinement still comes first, so
  // "I wrote a rule that allows this" is not a way out of the root.
  const engine = engineWith({
    id: 'allow-writes', description: '', priority: 100,
    predicate: { toolId: [FS_WRITE] }, action: { kind: 'Allow' },
  });

  assert.equal((await evaluate(engine, '../x.ts')).verdict, 'Deny');
});

test('a symbolic link out of the root is refused, and the reason says it is the root', async () => {
  // `root/.env` is a link to a file outside; the name is one the shipped glob matches, so both
  // halves would deny this — which is why the reason is asserted. It names the root, not the
  // rule, so this is confinement and not the pattern.
  const parent = await mkdtemp(path.join(tmpdir(), 'maf-policy-confine-'));
  try {
    const root = path.join(parent, 'root');
    await mkdir(root);
    await writeFile(path.join(parent, 'outside.txt'), 'secret\n', 'utf8');
    await symlink(path.join(parent, 'outside.txt'), path.join(root, '.env'));

    const ctx = baseCtx({ cwd: root, projectRoot: root });
    const decision = await new PolicyEngine(stubGraph)
      .evaluate(FS_WRITE, { path: '.env' }, ctx, ['.env']);

    assert.equal(decision.verdict, 'Deny');
    assert.match(decision.verdict === 'Deny' ? decision.reason : '', /outside the project root/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an allowed-path rule sees the resolved path, so ./-prefixed and plain paths agree', async () => {
  const engine = engineWith(ALLOWED_PATHS);

  // Inside the allowed tree by both spellings. Before this, `./tests/util.ts` did not match
  // `**/tests/**`, so the rule read it as "outside every allowed pattern" and denied it although
  // it was inside — the same non-normalisation that let `../.env` through, failing the other way.
  for (const spelling of ['tests/util.ts', './tests/util.ts', '__tests__/b.ts']) {
    assert.equal((await evaluate(engine, spelling)).verdict, 'Allow', `${JSON.stringify(spelling)}`);
  }

  assert.equal((await evaluate(engine, 'src/app.ts')).verdict, 'Deny',
    'and a file outside the tree is still denied');
});

test('one escaping path refuses a multi-path call', async () => {
  // `patch.apply` declares every file in its diff, so this is the shape a one-file-away patch has.
  const decision = await evaluate(engineWith(), 'ok.ts', ['ok.ts', '../.env']);
  assert.equal(decision.verdict, 'Deny');
});

test('a tool that declares no path is unaffected: there is nothing to confine', async () => {
  // `git.status` and `test.run` declare `[]`. A path rule cannot match them (by design), and
  // confinement has no path to refuse either.
  const decision = await engineWith(PROTECT_SECRETS).evaluate(FS_WRITE, {}, baseCtx(), []);
  assert.equal(decision.verdict, 'Allow');
});
