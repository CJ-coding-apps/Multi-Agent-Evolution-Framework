/**
 * WP-3.18 acceptance tests, authored from the WP-3.18 spec handed to this lane (that spec is not
 * shipped in this repository) before any implementation.
 *
 * ORACLE annotations name the spec clause or the record field each expectation comes from.
 * The implementation is never the oracle: the golden file and every expected string here were
 * written before `src/render.ts` existed, and the signing oracle below is an independent
 * JCS+HMAC implementation over the fixture bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  escapeHtml, renderRunView, renderSessionView, viewRun, viewSession,
} from '../index.js';
import type { ViewerIo } from '../index.js';

// Compiled to dist/__tests__, so the data beside the source is two levels up (the repo's own
// convention: packages/attestation/src/__tests__/intoto.test.ts).
const SOURCE_TESTS = path.join(__dirname, '..', '..', 'src', '__tests__');
const FIXTURES = path.join(SOURCE_TESTS, 'fixtures');
const GOLDEN = path.join(SOURCE_TESTS, 'golden');
const DEV_SIGNING = {};

const fixture = (name: string): Promise<string> => readFile(path.join(FIXTURES, name), 'utf8');

const BUNDLES = [
  'single.node.bundle.json',
  'parallel-dag.bundle.json',
  'failed-unscheduled.bundle.json',
  'lcm.bundle.json',
  'planning-failure.bundle.json',
  'legacy-0.2.bundle.json',
  'hostile.bundle.json',
  '0.3.1-inprocess-demo.bundle.json',
];

// ─── A signing oracle independent of the viewer ──────────────────────────────
// RFC 8785 for the JSON shapes these tests build (strings, numbers, arrays, plain objects).
// ORACLE: the record format — an in-toto statement, HMAC-SHA256 over the canonical bytes
// (packages/attestation/src/Attestor.ts, the protocol the viewer must verify).
function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${jcs(v)}`).join(',')}}`;
}

function sign(predicate: Record<string, unknown>, secret = 'dev-secret'): string {
  const diffHashes = (predicate['diffHashes'] ?? {}) as Record<string, string>;
  const subject = Object.entries(diffHashes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sha256]) => ({ name, digest: { sha256 } }));
  const statement = {
    _type: 'https://in-toto.io/Statement/v0.1',
    subject,
    predicateType: 'https://maf.dev/attestation/run/v1',
    predicate,
  };
  const signature = createHmac('sha256', secret).update(jcs(JSON.parse(JSON.stringify(statement))), 'utf8').digest('hex');
  return JSON.stringify({ ...statement, signature }, null, 2);
}

const predicate = (runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId,
  keySource: 'dev',
  provenance: {
    buildType: 'https://maf.dev/build/v1',
    builder: { id: '@maf/test@0.5.1', modelVersion: 'scripted' },
    invocation: { configSource: { uri: 'test', digest: { sha256: '0'.repeat(64) } }, parameters: {}, environment: {} },
    materials: [],
    runEnv: { platform: 'test', nodeVersion: 'test', timestamp: '2026-01-01T00:00:00.000Z' },
  },
  toolCalls: [],
  approvals: [],
  diffHashes: {},
  outcome: { status: 'Succeeded', nodes: [], unscheduled: [] },
  bundledAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

// ─── 1. Golden output (acceptance 1) ─────────────────────────────────────────

test('golden: the single-node bundle renders the authored HTML byte-for-byte', async () => {
  // ORACLE: acceptance 1 — "each renders byte-identical HTML on every run and platform".
  // The expected bytes were authored before the renderer (golden/single-node.html).
  const [bundleText, golden] = await Promise.all([fixture('single.node.bundle.json'), readFile(path.join(GOLDEN, 'single-node.html'), 'utf8')]);
  assert.equal(renderRunView({ bundleText, label: 'run-single', signing: DEV_SIGNING }), golden);
});

test('every fixture renders twice to the same bytes (no clock, stable order)', async () => {
  // ORACLE: acceptance 1 — determinism: "no timestamps from the clock, and stable ordering".
  for (const name of BUNDLES) {
    const bundleText = await fixture(name);
    const first = renderRunView({ bundleText, label: name, signing: DEV_SIGNING });
    const second = renderRunView({ bundleText, label: name, signing: DEV_SIGNING });
    assert.equal(first, second, `${name} is not deterministic`);
  }
});

test('the parallel DAG is ordered by start time and reports the peak overlap', async () => {
  // ORACLE: acceptance 1 and scope item 2 — "nodes and edges, start and finish times,
  // overlap at maxConcurrent > 1". The record has no edges or maxConcurrent, so the viewer
  // computes overlap from the recorded intervals and says the rest is not recorded.
  const html = renderRunView({ bundleText: await fixture('parallel-dag.bundle.json'), label: 'run-parallel', signing: DEV_SIGNING });
  const a = html.indexOf('<code>node-a</code>');
  const b = html.indexOf('<code>node-b</code>');
  const c = html.indexOf('<code>node-c</code>');
  assert.ok(a > -1 && b > -1 && c > -1, 'all three nodes are rendered');
  assert.ok(a < b && b < c, 'nodes appear in start-time order');
  assert.match(html, /Peak concurrent nodes: 2/);
  assert.match(html, /maxConcurrent and edges are not recorded/);
});

// ─── 2. Verification (acceptance 2) ──────────────────────────────────────────

test('a one-byte-tampered bundle renders the red banner and nothing trusted', async () => {
  // ORACLE: acceptance 2 — "a one-byte-tampered bundle ... renders the right banner";
  // scope item 1 — "a tampered or unsigned bundle renders a red banner".
  const original = await fixture('failed-unscheduled.bundle.json');
  const tampered = original.replace('"status": "Failed"', '"status": "Succeede"');
  assert.notEqual(tampered, original, 'the fixture actually changed');
  const html = renderRunView({ bundleText: tampered, label: 'run-failed', signing: DEV_SIGNING });
  assert.match(html, /class="banner invalid"/);
  assert.match(html, /NOT VERIFIED/);
  assert.doesNotMatch(html, /VERIFIED —/);
});

test('a dev-key bundle renders the development-key banner', async () => {
  // ORACLE: acceptance 2 — "a dev-key bundle renders the right banner";
  // packages/attestation/src/Attestor.ts VerifyResult.keySource ('dev' is no evidence).
  const html = renderRunView({ bundleText: await fixture('single.node.bundle.json'), label: 'run-single', signing: DEV_SIGNING });
  assert.match(html, /class="banner dev"/);
  assert.match(html, /public development key \(no evidence of authorship\)/);
});

test('an env-key bundle renders the green banner only under the matching secret', () => {
  // ORACLE: acceptance 2; Attestor.verify — a bundle claiming keySource 'env' must verify
  // with the env key, and the same bytes must fail under any other key.
  const text = sign(predicate('run-env', { keySource: 'env' }), 'env-secret');
  const good = renderRunView({ bundleText: text, label: 'run-env', signing: { secret: 'env-secret' } });
  assert.match(good, /class="banner valid"/);
  assert.match(good, /a key of your own \(MAF_SIGNING_KEY\)/);
  const wrong = renderRunView({ bundleText: text, label: 'run-env', signing: DEV_SIGNING });
  assert.match(wrong, /class="banner invalid"/);
});

test('an unsigned bundle renders the red banner instead of throwing', async () => {
  // ORACLE: acceptance 2 — "a tampered or unsigned bundle renders a red banner".
  // parseBundle throws for a missing signature, so the viewer must catch it.
  const signed = JSON.parse(await fixture('single.node.bundle.json')) as Record<string, unknown>;
  delete signed['signature'];
  const html = renderRunView({ bundleText: JSON.stringify(signed), label: 'no-signature', signing: DEV_SIGNING });
  assert.match(html, /class="banner invalid"/);
  assert.match(html, /NOT VERIFIED/);
});

// ─── 3. Escaping and the CSP meta (acceptance 3) ─────────────────────────────

test('hostile strings render inert and the CSP meta is present', async () => {
  // ORACLE: acceptance 3 — `<script>`, `"><img onerror>`, `</style>` and `javascript:` in
  // labels, tool inputs, model text and paths must render inert; the CSP meta is present.
  const html = renderRunView({ bundleText: await fixture('hostile.bundle.json'), label: 'run-hostile', signing: DEV_SIGNING });
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  assert.doesNotMatch(html, /<script>/i, 'no raw script element');
  assert.doesNotMatch(html, /<img /i, 'no raw img element');
  assert.doesNotMatch(html, /javascript:[^<]*<\/a>/i, 'no javascript: link');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;&gt;&lt;img/);
  assert.match(html, /&lt;\/style&gt;/);
});

test('escapeHtml escapes the five markup characters', () => {
  // ORACLE: acceptance 3 — "one escaping function"; scope "plain string templates and one
  // escaping function". The five characters whose omission breaks a text context.
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

// ─── 4. No network, no file reach (acceptance 4) ────────────────────────────

test('no rendered fixture contains an http or https URL', async () => {
  // ORACLE: acceptance 4 — "the HTML contains no `http`/`https` URLs".
  // scope item: a CSP meta forbids all network access.
  for (const name of BUNDLES) {
    const html = renderRunView({ bundleText: await fixture(name), label: name, signing: DEV_SIGNING });
    assert.doesNotMatch(html, /https?:\/\//, `${name} carries a URL`);
  }
});

function spyIo(files: Record<string, string>, missing: Set<string>): { io: ViewerIo; reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  const io: ViewerIo = {
    async readFile(p) {
      reads.push(p);
      if (missing.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      const text = files[p];
      if (text === undefined) throw new Error(`unexpected read: ${p}`);
      return text;
    },
    async writeFile(p, data) {
      writes.push(p);
      files[p] = data;
    },
  };
  return { io, reads, writes };
}

test('viewRun reads only the run bundle and its transcript, and writes only the out file', async () => {
  // ORACLE: acceptance 4 — "the viewer opens no file outside the inputs"; scope item:
  // "never reads files outside `.maf/` and the bundle given".
  const bundlePath = path.join('/proj', '.maf', 'attestations', 'run-single.bundle.json');
  const transcriptPath = path.join('/proj', '.maf', 'transcripts', 'run-single.jsonl');
  const outPath = path.join('/proj', '.maf', 'views', 'run-single.html');
  const { io, reads, writes } = spyIo({ [bundlePath]: await fixture('single.node.bundle.json') }, new Set([transcriptPath]));
  const result = await viewRun({ target: 'run-single', dir: '/proj' }, io);
  assert.deepEqual(reads, [bundlePath, transcriptPath]);
  assert.deepEqual(writes, [outPath]);
  assert.equal(result.outPath, outPath);
});

test('viewRun with a bundle path reads that file and nothing in .maf', async () => {
  // ORACLE: acceptance 4 and scope item 4 — a path is the input; no .maf read.
  const given = path.join('/elsewhere', 'given.bundle.json');
  const outDir = path.join('/proj', '.maf', 'views');
  const { io, reads, writes } = spyIo({ [given]: await fixture('single.node.bundle.json') }, new Set());
  const result = await viewRun({ target: given, dir: '/proj' }, io);
  assert.deepEqual(reads, [given]);
  assert.deepEqual(writes, [path.join(outDir, 'run-single.html')]);
  assert.equal(result.outPath, path.join(outDir, 'run-single.html'));
});

test('--out writes exactly the named file', async () => {
  // ORACLE: scope item 1 — `--out <file.html>`; the command writes one file.
  const bundlePath = path.join('/proj', '.maf', 'attestations', 'run-single.bundle.json');
  const { io, writes } = spyIo({ [bundlePath]: await fixture('single.node.bundle.json') }, new Set([path.join('/proj', '.maf', 'transcripts', 'run-single.jsonl')]));
  await viewRun({ target: 'run-single', dir: '/proj', out: '/tmp/view.html' }, io);
  assert.deepEqual(writes, ['/tmp/view.html']);
});

// ─── 5. Scale (acceptance 5) ────────────────────────────────────────────────

test('500 nodes and 10,000 surfaces render under 10 s into under 8 MiB', () => {
  // ORACLE: acceptance 5 — "a synthetic run of 500 nodes and 10,000 surfaces renders in under
  // 10 s, giving an HTML file under a stated size". Stated budget: 8 MiB (docs/changes/WP-3.18.md).
  const nodes = Array.from({ length: 500 }, (_, i) => ({
    nodeId: `node-${String(i).padStart(4, '0')}`,
    runId: 'run-scale',
    status: 'Succeeded',
    attempt: 1,
    startedAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    finishedAt: `2026-01-01T01:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
  }));
  const surfaces = Array.from({ length: 10_000 }, (_, i) => ({
    role: 'coder',
    taskId: `node-${String(i % 500).padStart(4, '0')}`,
    turn: Math.floor(i / 500) + 1,
    tier: 'in-process',
    systemPromptSha256: String(i % 10).repeat(64),
    promptSha256: String((i + 1) % 10).repeat(64),
    outputSha256: String((i + 2) % 10).repeat(64),
    toolCatalog: '[]',
    argv: [],
  }));
  const bundleText = sign(predicate('run-scale', {
    modelSurfaces: surfaces,
    executionTiers: nodes.map((n) => ({ nodeId: n.nodeId, role: 'coder', tier: 'in-process', adapter: 'scripted' })),
    outcome: { status: 'Succeeded', nodes, unscheduled: [] },
  }));
  const started = process.hrtime.bigint();
  const html = renderRunView({ bundleText, label: 'run-scale', signing: DEV_SIGNING });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 10_000, `render took ${elapsedMs} ms`);
  assert.ok(Buffer.byteLength(html, 'utf8') < 8 * 1024 * 1024, `html is ${Buffer.byteLength(html, 'utf8')} bytes`);
});

// ─── 6. Older bundles (acceptance 6) ────────────────────────────────────────

test('the legacy 0.2.x layout renders', async () => {
  // ORACLE: acceptance 6 — "every bundle version since 0.3.1 renders"; the legacy layout is the
  // 0.2.x shape Attestor still accepts (docs/SPEC-3.18 §Scope; Attestor.examine legacy path).
  const html = renderRunView({ bundleText: await fixture('legacy-0.2.bundle.json'), label: 'run-legacy', signing: DEV_SIGNING });
  assert.match(html, /class="banner dev"/);
  assert.match(html, /run-legacy/);
  assert.match(html, /<code>task-legacy<\/code>/);
});

test('the shipped 0.3.1 bundle renders its tool calls and policy counts', async () => {
  // ORACLE: acceptance 1 and 6 — the 0.3.1 fixture is named in both; its fields are the record's.
  const html = renderRunView({ bundleText: await fixture('0.3.1-inprocess-demo.bundle.json'), label: 'b044e466-04d9-459f-8dac-333886c2dec9', signing: DEV_SIGNING });
  assert.match(html, /b044e466-04d9-459f-8dac-333886c2dec9/);
  assert.match(html, /fs\.read/);
  assert.match(html, /test\.run/);
  assert.match(html, /delete-needs-a-human/);
  assert.match(html, /allow 3, deny 0, escalate 1, indeterminate 0/);
});

test('a missing field renders "not recorded", never 0 or empty', async () => {
  // ORACLE: acceptance 6 and AGENTS §4 — "'not recorded' is distinguishable from 'recorded as
  // empty'". The single-node fixture records no policy and no model surfaces.
  const html = renderRunView({ bundleText: await fixture('single.node.bundle.json'), label: 'run-single', signing: DEV_SIGNING });
  assert.match(html, /<dt>model surfaces<\/dt><dd>not recorded<\/dd>/);
  assert.match(html, /<dt>dollars<\/dt><dd>not recorded<\/dd>/);
  assert.match(html, /<dt>rule count<\/dt><dd>not recorded<\/dd>/);
  assert.doesNotMatch(html, /<dt>dollars<\/dt><dd>0/);
});

test('a planning failure renders its kind and no node verdicts', async () => {
  // ORACLE: scope item 4 and acceptance 1 — the fixture set covers "a planning failure";
  // RunOutcome.failure.kind is the record's own field (types/src/index.ts RunFailureKind).
  const html = renderRunView({ bundleText: await fixture('planning-failure.bundle.json'), label: 'run-plan-failed', signing: DEV_SIGNING });
  assert.match(html, /planning_failed/);
  assert.match(html, /<h2>Nodes \(not recorded\)<\/h2>/);
});

test('a failed node shows its failure kind and the unscheduled successors', async () => {
  // ORACLE: scope item 2 — "verdicts ... and unscheduled nodes"; acceptance 1 — "a failed node
  // with unscheduled successors". Fields: DagNodeExecution.failure.kind, RunOutcome.unscheduled.
  const html = renderRunView({ bundleText: await fixture('failed-unscheduled.bundle.json'), label: 'run-failed', signing: DEV_SIGNING });
  assert.match(html, /<td>no_change<\/td>/);
  assert.match(html, /<code>node-test<\/code>/);
  assert.match(html, /<code>node-deploy<\/code>/);
  assert.match(html, /<code>node-docs<\/code>/);
});

test('an LCM run shows its settings, reported tokens and degradation', async () => {
  // ORACLE: scope item 3 — "LCM summaries and expansions"; acceptance 1 — "an LCM run".
  // lcmSettings, ModelSurfaceRecord.lcmSummary.reportedTokens and LcmDegradedRecord.
  const html = renderRunView({ bundleText: await fixture('lcm.bundle.json'), label: 'run-lcm', signing: DEV_SIGNING });
  assert.match(html, /LLM-Map/);
  assert.match(html, /mode on/);
  assert.match(html, /512/);
  assert.match(html, /root-over-budget/);
});

// ─── Evolver sessions (scope item 5) ────────────────────────────────────────

test('an evolver session renders rounds, gate stages, train scores and a budget stop', async () => {
  // ORACLE: scope item 5 — "rounds, candidates and their labels, gate stages, train scores,
  // the held-out result with the test statistic, p-value, per-task counts and any contaminated
  // attempts, and budget stops". EvolveReport/EvolveRoundRecord/GateDecision fields.
  const html = renderSessionView({ reportText: await fixture('session.evolve.json'), label: 'evolve-1' });
  assert.match(html, /cand-sha-1/);
  assert.match(html, /cand-sha-2/);
  assert.match(html, /seesaw/);
  assert.match(html, /t1: (solved|pass|failed)/);
  assert.match(html, /stop reason: budget/);
});

test('an evolver session states the unrecorded held-out evidence instead of inventing it', async () => {
  // ORACLE: scope item 5 asks for the held-out result, test statistic, p-value and contaminated
  // attempts; EvolveReport carries none of them (D-57's second half is unimplemented), so
  // acceptance 6 / AGENTS §4 apply: "not recorded".
  const html = renderSessionView({ reportText: await fixture('session.evolve.json'), label: 'evolve-1' });
  assert.match(html, /held-out result<\/dt><dd>not recorded/);
  assert.match(html, /test statistic<\/dt><dd>not recorded/);
  assert.match(html, /p-value<\/dt><dd>not recorded/);
  assert.match(html, /contaminated attempts<\/dt><dd>not recorded/);
});

test('viewSession reads the session report and writes .maf/views/<id>.html', async () => {
  // ORACLE: scope item 1 — `maf view --session <id>`; the evolve command writes
  // `.maf/evolve/<id>.json` (packages/cli/src/commands/evolve.ts).
  const reportPath = path.join('/proj', '.maf', 'evolve', 'evolve-1.json');
  const outPath = path.join('/proj', '.maf', 'views', 'evolve-1.html');
  const { io, reads, writes } = spyIo({ [reportPath]: await fixture('session.evolve.json') }, new Set());
  const result = await viewSession({ target: 'evolve-1', dir: '/proj' }, io);
  assert.deepEqual(reads, [reportPath]);
  assert.deepEqual(writes, [outPath]);
  assert.equal(result.outPath, outPath);
});

test('a session view is deterministic and carries no URL', async () => {
  // ORACLE: acceptance 1 (determinism) and 4 (no network) applied to the session document.
  const reportText = await fixture('session.evolve.json');
  const first = renderSessionView({ reportText, label: 'evolve-1' });
  assert.equal(first, renderSessionView({ reportText, label: 'evolve-1' }));
  assert.doesNotMatch(first, /https?:\/\//);
  assert.match(first, /<meta http-equiv="Content-Security-Policy"/);
});
