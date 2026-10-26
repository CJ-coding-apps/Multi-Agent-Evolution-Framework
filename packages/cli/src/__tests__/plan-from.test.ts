import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { promisify } from 'node:util';
import { ScriptedAdapter } from '@maf/eval-harness';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { MemoryGraph, recallFailures } from '@maf/memory-graph';
import { DagSynthesizer, RetrievalAugmentedPlanner } from '@maf/planning-agent';
import type { CliAdapter } from '@maf/types';
import { makeRunId, makeToolId } from '@maf/types';
import { RoleRegistry, defineRoleName } from '@maf/roles';
import { runIsolatedGit } from '@maf/git-ops';
import { runInit } from '../commands/init.js';
import {
  driveRun, dirtyUserRepo, FIXED_SUM, lockFilePolicy, messageOf, needsLcm, onePlannedNode, registryOf, userState,
} from './runFixture.js';

// ORACLE (WP-3.6): `maf run --plan-from <spec>` runs the DAG the spec describes, in the order its
// edges name, and makes no planner call. Before this a spec's `edges` were kept beside the DAG and
// the scheduler ignored them, so a two-node spec could run both nodes at once; and the only way to
// get a plan was to ask a model, which is neither deterministic nor offline.

const FIRST = 'Fix sum.js so the test passes';
const SECOND = 'Add the helper module for the fix';
const HELPER = 'module.exports = (a, b) => a + b;\n';

test('maf run --plan-from: a two-node spec runs both nodes in edge order, with no model plan', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-from-'));
  try {
    const repo = await dirtyUserRepo(root);
    const spec = path.join(root, 'two-node.json');
    // Listed n2 first, n1 second (F2): both nodes are writers, so the writer lock also serializes
    // them — in listed order. Only the edge can make n2 wait, which is what this test proves.
    const specText = JSON.stringify({
      id: 'two-node',
      nodes: [
        { id: 'n2', label: SECOND },
        { id: 'n1', label: FIRST },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    await writeFile(spec, specText, 'utf8');

    const scripted = new ScriptedAdapter([
      { prompt: FIRST,  steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed sum.js.' },
      { prompt: SECOND, steps: [{ tool: 'fs.write', input: { path: 'helper.js', content: HELPER } }], final: 'Added helper.js.' },
    ]);

    // F3: the planner is not constructed on this path at all, not merely unused.
    let plannerBuilds = 0;
    const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', spec], {
      adapters: registryOf(scripted),
      createPlanner: () => {
        plannerBuilds += 1;
        throw new Error('the planner must not be constructed under --plan-from');
      },
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-from-key' } },
    });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.equal(plannerBuilds, 0, 'RetrievalAugmentedPlanner was never built');

    // The plan was read, not generated.
    assert.match(run.out, new RegExp(`\\[maf\\] plan: ${escapeRe(spec)} \\(read from spec, no model call\\)`));
    assert.match(run.out, /\[maf\] running DAG with 2 node\(s\)/);
    const firstAt = run.out.indexOf('[maf] → node n1 started');
    const firstEndAt = run.out.indexOf('[maf] ← node n1 Succeeded');
    const secondAt = run.out.indexOf('[maf] → node n2 started');
    assert.ok(firstAt >= 0 && firstEndAt >= 0 && secondAt >= 0, run.out);
    assert.ok(firstAt < firstEndAt, 'n1 starts before it ends');
    // The spec lists n2 first, so listed order alone would have started n2. The edge decides.
    assert.ok(firstEndAt < secondAt, 'n2 starts only after n1 ended: the edge is an ordering constraint');
    assert.ok(run.out.includes('[maf] ← node n2 Succeeded'));

    // No planner call: every invoke is the security gate's review, never a plan.
    const planCalls = scripted.exchanges.filter((e) => e.via === 'invoke' && e.kind === 'task');
    assert.deepEqual(planCalls, [], 'the planner was never asked');

    // Both nodes' work is on the run branch.
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const show = async (file: string) => (await runIsolatedGit(repo, ['show', `maf/${runId}:${file}`])).stdout;
    assert.equal(await show('sum.js'), FIXED_SUM);
    assert.equal(await show('helper.js'), HELPER);

    // F4: the record says where the plan came from — in the bundle, the transcript and the graph.
    const expected = { kind: 'spec', path: spec, sha256: crypto.createHash('sha256').update(specText, 'utf8').digest('hex') };
    const statement = JSON.parse(
      await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8'),
    ) as { predicate: { provenance: { invocation: { parameters: Record<string, unknown> } } } };
    assert.deepEqual(statement.predicate.provenance.invocation.parameters['planSource'], expected);

    const entry = await planSourceEntry(repo, runId);
    assert.ok(entry, 'the transcript says where the plan came from');
    assert.match(entry.content, /^plan source: spec .*two-node\.json \(sha256 [0-9a-f]{64}\)$/);
    assert.deepEqual(entry.metadata['planSource'], expected);

    const properties = await runNodeProperties(repo);
    assert.deepEqual(properties['planSource'], expected, 'the Run node names the spec and its digest');
    assert.equal(properties['taskDescription'], FIRST);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refused spec leaves a repository maf has never run in exactly as it found it (F1)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-refuse-fresh-'));
  try {
    const repo = await dirtyUserRepo(root);
    // The claim is about a repository maf has never touched: no `.maf/`, nothing in it.
    assert.equal(await exists(path.join(repo, '.maf')), false, 'the fixture starts with no .maf/');
    // Every path and its bytes, `.git/` included, plus git's own view of the working tree. A name
    // list would miss a rewritten file; a digest would miss a new empty one.
    const tree = await treeDigest(repo);
    const state = await userState(repo);

    await refuseEverySpec(repo, root, 'plan-refuse-fresh-key');

    assert.deepEqual(await treeDigest(repo), tree, 'no file was created, rewritten or removed');
    assert.deepEqual(await userState(repo), state, "the user's checkout is untouched");
    assert.equal(await exists(path.join(repo, '.maf')), false, 'no .maf/ was created — not its directory, not its .gitignore, not a harness');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refused spec leaves a repository maf has run in as it was (F1)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-refuse-'));
  try {
    const repo = await dirtyUserRepo(root);
    // A repository maf has run in: `.maf/` holds the shipped policy, roles, config, prompts and
    // the committed default harness. The refusal must not add to it, and must not rewrite what is
    // there — the `.gitignore` `ensureMafDir` writes included.
    await runInit({ dir: repo, out: { write: () => {} } });
    const mafTree = await treeDigest(path.join(repo, '.maf'));
    const state = await userState(repo);

    await refuseEverySpec(repo, root, 'plan-refuse-key');

    assert.deepEqual(await treeDigest(path.join(repo, '.maf')), mafTree, '.maf/ was not written to');
    assert.deepEqual(await userState(repo), state, "the user's checkout is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a malformed spec is refused before the backend is resolved or probed (D-59 merge duty 5)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-refuse-no-backend-'));
  try {
    const repo = await dirtyUserRepo(root);
    for (const { name, body, expected } of SPEC_REFUSALS) {
      const spec = path.join(root, `${name}.json`);
      if (body !== undefined) await writeFile(spec, body);
      // Both adapter shapes: one with a preflight (`--version`/`--help`, the claude path) and one
      // without (the `isAvailable` path). Neither may be reached — a malformed spec is the
      // operator's error, and a run that probed a backend for it has paid for the wrong question.
      for (const withPreflight of [false, true]) {
        const counts = { available: 0, preflight: 0, invoked: 0 };
        const inner = new ScriptedAdapter([]);
        const adapter: CliAdapter = {
          name:          'claude',
          capabilities:  () => inner.capabilities(),
          isAvailable:   async () => { counts.available += 1; return true; },
          invoke:        (o) => { counts.invoked += 1; return inner.invoke(o); },
          stream:        (o) => inner.stream(o),
          ...(withPreflight
            ? { preflight: async () => { counts.preflight += 1; return undefined; } }
            : {}),
        };
        const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'claude', '--plan-from', spec], {
          adapters: registryOf(adapter),
          io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-no-backend-key' } },
        });
        const which = `${name}/${withPreflight ? 'preflight' : 'availability'}`;
        assert.ok(run.error !== undefined, `${which}: the run was expected to refuse\n${run.out}${run.err}`);
        assert.match(messageOf(run.error), expected, which);
        assert.equal(counts.available, 0, `${which}: the availability check was never asked`);
        assert.equal(counts.preflight, 0, `${which}: preflight was never asked`);
        assert.equal(counts.invoked, 0, `${which}: the backend was never invoked`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a spec node failure is recorded under the run title, so recall finds it (F7)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-recall-'));
  try {
    const repo = await dirtyUserRepo(root);
    const policy = await lockFilePolicy(root);
    // The harness requires review and no reviewer is available, so the writer's change is refused
    // and the node fails — the failure is what the memory graph records.
    await new HarnessStore(path.join(repo, '.maf')).save(mintHarnessConfig({
      id: 'strict', processorBundles: [], reviewGate: { required: true },
      roleSet: { version: 1, defaultRole: 'coder', roles: [{
        role: 'coder', systemPrompt: 'Fix the code.', allowedTools: ['fs.read', 'fs.write'], execution: 'in-process',
      }] },
    }));
    const spec = path.join(root, 'one-node.json');
    await writeFile(spec, JSON.stringify({ nodes: [{ id: 'n1', label: FIRST }] }), 'utf8');
    const scripted = new ScriptedAdapter([
      { prompt: FIRST, steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed sum.js.' },
    ]);

    const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--harness', 'strict', '--policy', policy, '--plan-from', spec], {
      adapters: registryOf(scripted),
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-recall-key' } },
    });
    assert.match(messageOf(run.error), /run did not succeed \(Failed\)/, `${run.out}\n${run.err}`);

    // The spec carries no recall of its own, but every node it makes carries the run's title, so
    // the failure is filed under that title and a later plan for the same task can find it.
    const graph = new MemoryGraph(path.join(repo, '.maf', 'memory.kuzu'));
    try {
      const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
      assert.ok(runId, run.out);
      const recalled = await recallFailures(graph, { title: FIRST, limit: 5 });
      assert.equal(recalled.length, 1, 'recall finds the failure a spec-made node recorded');
      assert.equal(recalled[0]?.runId, runId);
      assert.equal(recalled[0]?.role, 'coder');

      const rows = await graph.run({
        cypher: "MATCH (t:MemoryNode {kind: 'Task'}) RETURN t.label AS label, t.properties AS props",
        params: {},
      });
      assert.equal(rows.length, 1, 'one failed task was recorded');
      const row = rows[0] as { label: string; props: string };
      assert.equal(row.label, FIRST, 'the task is the node’s description');
      // The run's title, on the record itself: `recallFailures` matches it in `properties` as JSON
      // text, and this is the field a spec node has to carry for that to be possible.
      const properties = JSON.parse(row.props) as { runTitle?: string; nodeLabel?: string };
      assert.equal(properties.runTitle, FIRST);
      assert.equal(properties.nodeLabel, FIRST);
    } finally {
      await graph.close();
    }

    // R9: that failure is now in the graph under this exact title, which is the state a planner
    // reads before it decides to insert review gates. The same spec, run again with the same title,
    // is still exactly the one node the operator wrote — memory must not rewrite a human's plan.
    const again = await driveRun(
      [FIRST, '--dir', repo, '--adapter', 'scripted', '--harness', 'strict', '--policy', policy, '--plan-from', spec],
      { adapters: registryOf(scripted), io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-recall-key-2' } } },
    );
    assert.match(again.out, /\[maf\] running DAG with 1 node\(s\)/, `a review gate was inserted\n${again.out}`);
    assert.match(again.out, /\[maf\] ← node n1 Failed/, again.out);

    // A gate that recall inserted would also be a field on the DAG, and no command prints that
    // field — so the node count above cannot see one. The read is made here, with the same entry
    // point and the same options `run.ts` gives it (`fromFile` with the run title and nothing
    // else), and both ways round: passed this failure, recall flags the node; passed nothing, as
    // the spec path does, it does not. A synthesizer that invented a default pattern would flag it
    // in the first read, and one that ignored recall entirely would not flag it in the second.
    const synth = new DagSynthesizer(RoleRegistry.fromSet({
      version: 1, defaultRole: defineRoleName('coder'),
      roles: [{
        role: defineRoleName('coder'), systemPrompt: 'Fix the code.',
        allowedTools: [makeToolId('fs.read'), makeToolId('fs.write')], execution: 'in-process',
      }],
    }, path.join(repo, '.maf')));
    const noRecall = await synth.fromFile(spec, makeRunId('plan-recall-check'), { runTitle: FIRST });
    assert.deepEqual(noRecall.dag.config.reviewGateNodeIds, [], 'the spec path inserts no review gate');
    const withRecall = await synth.fromFile(spec, makeRunId('plan-recall-check'), {
      runTitle: FIRST,
      avoidPatterns: [{ taskLabel: FIRST, filePaths: ['sum.js'], failureType: 'test', occurrences: 1, lastSeen: '2026-10-01' }],
    });
    assert.deepEqual(withRecall.dag.config.reviewGateNodeIds, ['n1'],
      'the empty list above is a decision, not a label that could never match: this failure does flag it');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a run the planner planned records that the planner made the plan (F4)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-planner-'));
  try {
    const repo = await dirtyUserRepo(root);
    const scripted = new ScriptedAdapter([
      onePlannedNode(FIRST),
      { prompt: FIRST, steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed sum.js.' },
    ]);
    let plannerBuilds = 0;
    const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted'], {
      adapters: registryOf(scripted),
      createPlanner: (args) => {
        plannerBuilds += 1;
        return new RetrievalAugmentedPlanner(args);
      },
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-planner-key' } },
    });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    assert.equal(plannerBuilds, 1, 'the seam is wired to the real planner');

    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const statement = JSON.parse(
      await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8'),
    ) as { predicate: { provenance: { invocation: { parameters: Record<string, unknown> } } } };
    assert.deepEqual(statement.predicate.provenance.invocation.parameters['planSource'], { kind: 'planner' });

    const entry = await planSourceEntry(repo, runId);
    assert.equal(entry?.content, 'plan source: the planner');
    assert.deepEqual((await runNodeProperties(repo))['planSource'], { kind: 'planner' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a relative spec path is resolved against --dir, not the working directory (R2)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-dir-'));
  try {
    const repo = await dirtyUserRepo(root);
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    const spec = path.join(repo, 'two-node.json');
    await writeFile(spec, JSON.stringify({
      nodes: [{ id: 'n1', label: FIRST }, { id: 'n2', label: SECOND }],
      edges: [{ from: 'n1', to: 'n2' }],
    }), 'utf8');

    // Under --dir and not under the working directory, so a reader that resolves against the
    // working directory cannot find it. The plan line names the file that was read.
    const found = await mafCli(
      ['run', FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', 'two-node.json'], elsewhere);
    assert.match(found.out, new RegExp(`\\[maf\\] plan: ${escapeRe(spec)} \\(read from spec, no model call\\)`));

    // A spec that exists only in the working directory is not found, and the refusal names the path
    // under --dir — the file it looked for.
    await writeFile(path.join(elsewhere, 'only-in-cwd.json'),
      JSON.stringify({ nodes: [{ id: 'n1', label: FIRST }] }), 'utf8');
    const missing = await mafCli(
      ['run', FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', 'only-in-cwd.json'], elsewhere);
    assert.notEqual(missing.code, 0, `the run refused\n${missing.out}${missing.err}`);
    assert.match(missing.err, new RegExp(`could not read ${escapeRe(path.join(repo, 'only-in-cwd.json'))}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the built maf binary reads a spec, runs its edge order, and refuses a malformed one (R5, S1)', async () => {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'maf-plan-built-'));
  const refuseRoot = await mkdtemp(path.join(tmpdir(), 'maf-plan-built-refuse-'));
  try {
    // `packages/cli/dist/main.js` is what `npm i -g maf` runs. The scripted adapter the binary builds
    // for itself carries no scripts, so the first node to run fails at the adapter; that is the
    // adapter, not the spec. A successful run is therefore not available here — so this proves the
    // edge order the way the binary makes it observable: by what did *not* run. The spec lists `n2`
    // first and `n1` second, with the edge `n1 -> n2` (S1). Both nodes are writers, so the writer lock
    // serializes them in listed order — which alone would start `n2` first. Only the edge can make
    // `n2` wait for `n1`, so when `n1` fails, `n2` must never run: the run reports `failed: [n1],
    // never ran: [n2]`. Drop the edge rule and `n2` is independent — it starts first (listed first)
    // and runs — which is exactly what the edge-rule mutation makes this test catch.
    const repo = await dirtyUserRepo(runRoot);
    const spec = path.join(repo, 'two-node.json');
    await writeFile(spec, JSON.stringify({
      nodes: [{ id: 'n2', label: SECOND }, { id: 'n1', label: FIRST }],
      edges: [{ from: 'n1', to: 'n2' }],
    }), 'utf8');
    const ran = await mafCli(['run', FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', spec], repo);
    assert.match(ran.out, new RegExp(`\\[maf\\] plan: ${escapeRe(spec)} \\(read from spec, no model call\\)`), ran.out);
    assert.match(ran.out, /\[maf\] running DAG with 2 node\(s\)/, ran.out);
    assert.match(ran.out, /\[maf\] → node n1 started/, 'n1 is dispatched');
    assert.match(ran.out, /\[maf\] ← node n1 Failed/, 'n1 fails at the scriptless adapter');
    // The edge is the whole claim: n1 failed, so n2 — listed first — never ran. Without the edge rule
    // n2 is independent and the writer lock starts it first, so it would run; it does not.
    assert.doesNotMatch(ran.out, /\[maf\] → node n2 started/, 'n2 never started: the edge made it wait for n1, which failed');
    assert.match(ran.err, /run did not succeed \(Failed\) — failed: \[n1\], never ran: \[n2\]/, ran.err);
    assert.doesNotMatch(ran.out, /\[maf\] planning/, 'no model plan was asked for');
    assert.notEqual(ran.code, 0, 'a failed node fails the run');

    // A spec the schema refuses stops the binary before anything is written, in a repository maf has
    // never run in: no `.maf/`, and the refusal is the message the in-process test sees.
    const fresh = await dirtyUserRepo(refuseRoot);
    const bad = path.join(refuseRoot, 'malformed.json');
    await writeFile(bad, '{"nodes":[{"id":"a","label":"a","agnetRole":"reviewer"}]}', 'utf8');
    const refused = await mafCli(['run', FIRST, '--dir', fresh, '--adapter', 'scripted', '--plan-from', bad], fresh);
    assert.notEqual(refused.code, 0, `${refused.out}${refused.err}`);
    assert.match(refused.err, /\[maf\] error: .*unknown key\(s\) "agnetRole"/, refused.err);
    assert.equal(await exists(path.join(fresh, '.maf')), false, 'the refusal created nothing');
  } finally {
    await rm(runRoot, { recursive: true, force: true });
    await rm(refuseRoot, { recursive: true, force: true });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const MAIN = path.resolve(__dirname, '..', 'main.js');
const execFileAsync = promisify(execFile);

interface CliRun { code: number; out: string; err: string }

/** `maf <args>` as the built binary runs it, from `cwd` — the only way to vary the working directory. */
async function mafCli(args: readonly string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [MAIN, ...args], { cwd, timeout: 240_000 });
    return { code: 0, out: stdout, err: stderr };
  } catch (err: unknown) {
    const failed = err as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : 1, out: failed.stdout ?? '', err: failed.stderr ?? '' };
  }
}

/**
 * Every path under `dir` with the sha256 of its bytes — `.git/` included. A refusal that created a
 * file shows up as a new key, one that rewrote a file as a changed digest, and one that created an
 * empty directory as a new `dir` entry.
 */
async function treeDigest(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : path.join(rel, entry.name);
    if (entry.isDirectory()) {
      out[child] = 'dir';
      Object.assign(out, await treeDigest(dir, child));
    } else {
      out[child] = crypto.createHash('sha256').update(await readFile(path.join(dir, child))).digest('hex');
    }
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

/** Every refusal case, run against `repo` with a spec written outside it. */
const SPEC_REFUSALS: ReadonlyArray<{ name: string; body: string | Buffer | undefined; expected: RegExp }> = [
  { name: 'unknown-node-key', body: '{"nodes":[{"id":"a","label":"a","agnetRole":"reviewer"}]}', expected: /unknown key\(s\) "agnetRole"/ },
  { name: 'unknown-spec-key', body: '{"nodes":[{"id":"a","label":"a"}],"config":{}}', expected: /unknown key\(s\) "config"/ },
  { name: 'duplicate-id', body: '{"nodes":[{"id":"a","label":"a"},{"id":"a","label":"b"}]}', expected: /duplicate node id "a"/ },
  { name: 'unknown-endpoint', body: '{"nodes":[{"id":"a","label":"a"}],"edges":[{"from":"a","to":"ghost"}]}', expected: /edge names unknown node "ghost"/ },
  { name: 'cycle', body: '{"nodes":[{"id":"a","label":"a"},{"id":"b","label":"b"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}', expected: /dependency cycle/ },
  { name: 'bad-utf8', body: Buffer.from([0x7b, 0x22, 0x6e, 0xff, 0x7d]), expected: /is not valid UTF-8; a JSON workflow spec must be UTF-8 text/ },
  { name: 'not-json', body: 'nodes: [', expected: /could not read .*not-json\.json as a JSON workflow spec/ },
  { name: 'unknown-role', body: '{"nodes":[{"id":"a","label":"a","agentRole":"ghost"}]}', expected: /asks for unknown agentRole "ghost"/ },
  { name: 'timeout-zero', body: '{"nodes":[{"id":"a","label":"a","timeoutMs":0}]}', expected: /from 1 to 2147483647/ },
  { name: 'timeout-too-large', body: '{"nodes":[{"id":"a","label":"a","timeoutMs":2147483648}]}', expected: /from 1 to 2147483647/ },
  { name: 'no-nodes', body: '{"nodes":[]}', expected: /has no nodes/ },
  { name: 'missing-file', body: undefined, expected: /could not read .*missing-file\.json/ },
];

async function refuseEverySpec(repo: string, root: string, envKey: string): Promise<void> {
  for (const { name, body, expected } of SPEC_REFUSALS) {
    const spec = path.join(root, `${name}.json`);
    if (body !== undefined) await writeFile(spec, body);
    // No `--harness`: the run mints the legacy harness from the roles file, which is the write a
    // refusal must be able to skip. A pre-saved harness would hide exactly the defect under test.
    const scripted = new ScriptedAdapter([]);
    const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', spec], {
      adapters: registryOf(scripted),
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: envKey } },
    });
    assert.ok(run.error !== undefined, `${name}: the run was expected to refuse\n${run.out}${run.err}`);
    assert.match(messageOf(run.error), expected, name);
    assert.doesNotMatch(run.out, /\[maf\] planning/, `${name}: the planner was not reached`);
  }
  assert.equal((await runIsolatedGit(repo, ['branch', '--list', 'maf/*'])).stdout.trim(), '', 'no `maf/*` branch was created');
}

/** The transcript entry that says where the plan came from. */
async function planSourceEntry(repo: string, runId: string): Promise<
  { content: string; metadata: Record<string, unknown> } | undefined
> {
  const text = await readFile(path.join(repo, '.maf', 'transcripts', `${runId}.jsonl`), 'utf8');
  const entries = text.trim().split('\n').map((line) => JSON.parse(line) as {
    role: string; content: string; metadata: Record<string, unknown>;
  });
  return entries.find((e) => e.metadata['planSource'] !== undefined);
}

/** The Run node's properties, as the run wrote them. */
async function runNodeProperties(repo: string): Promise<Record<string, unknown>> {
  const graph = new MemoryGraph(path.join(repo, '.maf', 'memory.kuzu'));
  try {
    const rows = await graph.run({
      cypher: "MATCH (n:MemoryNode) WHERE n.kind = 'Run' RETURN n.properties AS p",
      params: {},
    });
    const row = rows[0] as { p?: string } | undefined;
    assert.ok(row?.p !== undefined, 'a Run node was written');
    return JSON.parse(row.p) as Record<string, unknown>;
  } finally {
    await graph.close();
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
