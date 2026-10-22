import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { MemoryGraph, recallFailures } from '@maf/memory-graph';
import { RetrievalAugmentedPlanner } from '@maf/planning-agent';
import { runIsolatedGit } from '@maf/git-ops';
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

test('every spec refusal leaves no branch, no worktree and no store (F1)', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-refuse-'));
  try {
    const repo = await dirtyUserRepo(root);
    // A stored harness, so the run does not mint one into `.maf/harnesses` before it refuses: the
    // snapshot below must only be able to change through a store this run opens.
    await new HarnessStore(path.join(repo, '.maf')).save(mintHarnessConfig({
      id: 'plain', processorBundles: [], reviewGate: { required: false },
      roleSet: { version: 1, defaultRole: 'coder', roles: [{
        role: 'coder', systemPrompt: 'Fix the code.', allowedTools: ['fs.read', 'fs.write'], execution: 'in-process',
      }] },
    }));
    // `ensureMafDir` writes `.maf/.gitignore` on every run, before the spec is read, and leaves one
    // that is already there as it is. Seed it so the snapshot below can only change through a store.
    await writeFile(path.join(repo, '.maf', '.gitignore'), '# seeded by the test\n', 'utf8');
    const before = await userState(repo);
    const mafTree = await listTree(path.join(repo, '.maf'));

    const cases: Array<{ name: string; body: string | undefined; expected: RegExp }> = [
      { name: 'unknown-node-key', body: '{"nodes":[{"id":"a","label":"a","agnetRole":"reviewer"}]}', expected: /unknown key\(s\) "agnetRole"/ },
      { name: 'unknown-spec-key', body: '{"nodes":[{"id":"a","label":"a"}],"config":{}}', expected: /unknown key\(s\) "config"/ },
      { name: 'duplicate-id', body: '{"nodes":[{"id":"a","label":"a"},{"id":"a","label":"b"}]}', expected: /duplicate node id "a"/ },
      { name: 'unknown-endpoint', body: '{"nodes":[{"id":"a","label":"a"}],"edges":[{"from":"a","to":"ghost"}]}', expected: /edge names unknown node "ghost"/ },
      { name: 'cycle', body: '{"nodes":[{"id":"a","label":"a"},{"id":"b","label":"b"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}', expected: /dependency cycle/ },
      { name: 'no-nodes', body: '{"nodes":[]}', expected: /has no nodes/ },
      { name: 'missing-file', body: undefined, expected: /could not read .*missing-file\.json/ },
    ];

    for (const { name, body, expected } of cases) {
      const spec = path.join(root, `${name}.json`);
      if (body !== undefined) await writeFile(spec, body, 'utf8');
      const scripted = new ScriptedAdapter([]);
      const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--harness', 'plain', '--plan-from', spec], {
        adapters: registryOf(scripted),
        io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-refuse-key' } },
      });
      assert.ok(run.error !== undefined, `${name}: the run was expected to refuse\n${run.out}${run.err}`);
      assert.match(messageOf(run.error), expected, name);
      assert.doesNotMatch(run.out, /\[maf\] planning/, `${name}: the planner was not reached`);
    }

    assert.equal((await runIsolatedGit(repo, ['branch', '--list', 'maf/*'])).stdout.trim(), '', 'no `maf/*` branch was created');
    assert.deepEqual(await listTree(path.join(repo, '.maf')), mafTree, '.maf gained no store');
    assert.deepEqual(await userState(repo), before, "the user's checkout is untouched");
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
      graph.close();
    }
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/** Every path under `dir`, relative. A store this run opened shows up as a new entry. */
async function listTree(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = rel === '' ? entry.name : path.join(rel, entry.name);
    out.push(child);
    if (entry.isDirectory()) out.push(...await listTree(dir, child));
  }
  return out.sort();
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
    graph.close();
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
