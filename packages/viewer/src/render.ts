/**
 * HTML rendering: plain string templates, one escaping function, no clock and no locale.
 *
 * The document is self-contained — the CSP meta below forbids every network request, so a bundle
 * that carries a URL in its content cannot make the page fetch it, and the page carries no URL of
 * its own either. Ordering comes from the record's own times and ids, never from iteration order.
 */
import { Attestor, parseBundle } from '@maf/attestation';
import type { AnyBundle, SigningOptions } from '@maf/attestation';
import type { Banner, NodeView, RunView, SessionView } from './model.js';
import { buildRunView, buildSessionView, invalidRunView } from './model.js';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; " +
  "connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

const CSS = [
  ':root{color-scheme:light dark;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}',
  'body{margin:0;padding:24px;max-width:1100px}',
  'h1{font-size:18px;margin:0 0 4px}',
  'h2{font-size:15px;margin:24px 0 8px}',
  'table{border-collapse:collapse;width:100%;margin:8px 0}',
  'th,td{border:1px solid #8884;padding:4px 6px;text-align:left;vertical-align:top}',
  'th{background:#8881}',
  '.banner{padding:12px 16px;border-radius:6px;border:1px solid}',
  '.banner.valid{border-color:#2a7;background:#2a71}',
  '.banner.dev{border-color:#d90;background:#d901}',
  '.banner.invalid{border-color:#d22;background:#d221}',
  '.banner.session{border-color:#888;background:#8881}',
  '.muted{color:#888}',
  'code{word-break:break-all}',
].join('\n');

/** The one escaping function. `<&>"'` are the five characters whose omission breaks a text context. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const e = escapeHtml;

const NOT_RECORDED = 'not recorded';
const NONE_RECORDED = 'none (recorded)';

const recorded = (value: string | null): string => (value === null ? NOT_RECORDED : e(value));
const number = (value: number | null): string => (value === null ? NOT_RECORDED : String(value));
const millis = (value: number | null): string => (value === null ? NOT_RECORDED : `${value} ms`);

function document(banner: Banner, title: string, heading: string, sections: string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<title>${e(title)}</title>`,
    '<style>',
    CSS,
    '</style>',
    '</head>',
    '<body>',
    `<header id="verification" class="banner ${banner.kind}">`,
    `<h1>${e(heading)}</h1>`,
    `<p class="verdict">${e(banner.verdict)}</p>`,
    ...(banner.detail !== undefined ? [`<p class="detail">${e(banner.detail)}</p>`] : []),
    '</header>',
    '<main>',
    ...sections,
    '</main>',
    '<footer class="muted">maf view — self-contained; every network request is forbidden by the CSP above.</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ─── Run document ───────────────────────────────────────────────────────────

function runSection(view: RunView): string {
  return [
    '<section id="run">',
    '<h2>Run</h2>',
    '<dl>',
    `<dt>status</dt><dd>${recorded(view.status)}</dd>`,
    `<dt>started</dt><dd>${recorded(view.startedAt)}</dd>`,
    `<dt>finished</dt><dd>${recorded(view.finishedAt)}</dd>`,
    `<dt>wall-clock</dt><dd>${millis(view.wallClockMs)}</dd>`,
    `<dt>diff subjects</dt><dd>${view.diffSubjects}</dd>`,
    ...(view.runFailure !== null ? [`<dt>failure</dt><dd>${e(view.runFailure)}</dd>`] : []),
    ...(view.goldens !== null ? [`<dt>goldens</dt><dd>${e(view.goldens)}</dd>`] : []),
    '</dl>',
    '</section>',
  ].join('\n');
}

function nodesSection(view: RunView): string {
  const heading = view.nodesRecorded ? `Nodes (${view.nodes.length})` : `Nodes (${NOT_RECORDED})`;
  const rows = view.nodes.map((node) => [
    '<tr>',
    `<td><code>${e(node.nodeId)}</code></td>`,
    `<td>${e(node.status)}</td>`,
    `<td>${node.attempt}</td>`,
    `<td>${recorded(node.role)}</td>`,
    `<td>${recorded(node.tier)}</td>`,
    `<td>${recorded(node.adapter)}</td>`,
    `<td>${recorded(node.startedAt)}</td>`,
    `<td>${recorded(node.finishedAt)}</td>`,
    `<td>${node.failureKind === null ? 'none' : e(node.failureKind)}</td>`,
    '</tr>',
  ].join(''));
  const table = view.nodesRecorded && rows.length > 0
    ? [
      '<table>',
      '<thead>',
      '<tr><th>node</th><th>status</th><th>attempt</th><th>role</th><th>tier</th><th>adapter</th><th>started</th><th>finished</th><th>failure</th></tr>',
      '</thead>',
      '<tbody>',
      ...rows,
      '</tbody>',
      '</table>',
    ]
    : [];
  return [
    '<section id="nodes">',
    `<h2>${heading}</h2>`,
    ...table,
    `<p class="muted">Peak concurrent nodes: ${number(view.peakConcurrency)} (computed from the recorded times; maxConcurrent and edges are not recorded).</p>`,
    '</section>',
  ].join('\n');
}

function surfacesTable(node: NodeView): string[] {
  if (node.surfaces === null || node.surfaces.length === 0) return [];
  const rows = node.surfaces.map((surface) => [
    '<tr>',
    `<td>${e(surface.role)}</td>`,
    `<td>${surface.turn}</td>`,
    `<td>${recorded(surface.tier)}</td>`,
    `<td>${recorded(surface.kind)}</td>`,
    `<td>${recorded(surface.model)}</td>`,
    `<td>${recorded(surface.surfaceSource)}</td>`,
    `<td>${number(surface.reportedTokens)}</td>`,
    `<td>${recorded(surface.error)}</td>`,
    `<td><code>${recorded(surface.systemPromptSha256)}</code></td>`,
    `<td><code>${recorded(surface.promptSha256)}</code></td>`,
    `<td><code>${recorded(surface.stdinSha256)}</code></td>`,
    `<td><code>${recorded(surface.outputSha256)}</code></td>`,
    '</tr>',
  ].join(''));
  return [
    '<table>',
    '<thead>',
    '<tr><th>role</th><th>turn</th><th>tier</th><th>kind</th><th>model</th><th>surface source</th><th>reported tokens</th><th>error</th><th>system prompt sha256</th><th>prompt sha256</th><th>stdin sha256</th><th>output sha256</th></tr>',
    '</thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
  ];
}

function callsTable(node: NodeView): string[] {
  if (node.calls === null || node.calls.length === 0) return [];
  const rows = node.calls.map((call) => [
    '<tr>',
    `<td><code>${e(call.toolId)}</code></td>`,
    `<td>${e(call.verdict)}</td>`,
    `<td>${recorded(call.ruleId)}</td>`,
    `<td>${call.exitCode}</td>`,
    `<td>${call.durationMs} ms</td>`,
    `<td><pre>${e(call.input)}</pre></td>`,
    `<td><pre>${e(call.output)}</pre></td>`,
    '</tr>',
  ].join(''));
  return [
    '<table>',
    '<thead>',
    '<tr><th>tool</th><th>verdict</th><th>rule</th><th>exit</th><th>duration</th><th>input</th><th>output</th></tr>',
    '</thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
  ];
}

function nodeSection(node: NodeView): string {
  const paths = node.changedPaths === null
    ? NOT_RECORDED
    : node.changedPaths.length === 0 ? NONE_RECORDED : node.changedPaths.map((p) => `<code>${e(p)}</code>`).join(', ');
  const security = node.security === null
    ? NOT_RECORDED
    : node.security.length === 0 ? NONE_RECORDED : node.security.map(e).join('; ');
  return [
    `<section id="node-${e(node.nodeId)}">`,
    `<h2>Node <code>${e(node.nodeId)}</code></h2>`,
    '<dl>',
    ...(node.failureDetail !== null ? [`<dt>failure</dt><dd>${e(node.failureDetail)}</dd>`] : []),
    `<dt>model surfaces</dt><dd>${node.surfaces === null ? NOT_RECORDED : node.surfaces.length}</dd>`,
    `<dt>tool calls</dt><dd>${node.calls === null ? NOT_RECORDED : node.calls.length === 0 ? NONE_RECORDED : node.calls.length}</dd>`,
    `<dt>security gate</dt><dd>${security}</dd>`,
    `<dt>LCM summaries</dt><dd>${number(node.lcmSummaryCount)}</dd>`,
    `<dt>LCM degradation</dt><dd>${node.degraded.length === 0 ? NONE_RECORDED : node.degraded.map(e).join('; ')}</dd>`,
    `<dt>changed paths</dt><dd>${paths}</dd>`,
    `<dt>model text</dt><dd>${node.modelText === null ? NOT_RECORDED : node.modelText.length === 0 ? NONE_RECORDED : `${node.modelText.length} assistant entries`}</dd>`,
    '</dl>',
    ...surfacesTable(node),
    ...callsTable(node),
    ...(node.modelText === null ? [] : node.modelText.map((text) => `<pre class="text">${e(text)}</pre>`)),
    '</section>',
  ].join('\n');
}

function totalsSection(view: RunView): string {
  const byKind = view.callsByKind === null
    ? NOT_RECORDED
    : view.callsByKind === '' ? NONE_RECORDED : e(view.callsByKind);
  return [
    '<section id="totals">',
    '<h2>Totals</h2>',
    '<dl>',
    `<dt>calls by kind</dt><dd>${byKind}</dd>`,
    `<dt>tokens (reported)</dt><dd>${number(view.reportedTokens)}</dd>`,
    `<dt>tokens (estimated)</dt><dd>${number(view.estimatedTokens)}</dd>`,
    // No record field carries a price, and a viewer must not invent one: dollars stay unrecorded.
    `<dt>dollars</dt><dd>${NOT_RECORDED}</dd>`,
    `<dt>wall-clock</dt><dd>${millis(view.wallClockMs)}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

function policySection(view: RunView): string {
  const policy = view.policy;
  return [
    '<section id="policy">',
    '<h2>Policy in force</h2>',
    '<dl>',
    `<dt>rule count</dt><dd>${policy === null ? NOT_RECORDED : policy.ruleCount}</dd>`,
    `<dt>allow / deny / escalate / indeterminate</dt><dd>${policy === null ? NOT_RECORDED : e(policy.counts)}</dd>`,
    `<dt>source</dt><dd>${policy === null ? NOT_RECORDED : recorded(policy.source)}</dd>`,
    `<dt>rules</dt><dd>${policy === null ? NOT_RECORDED : policy.rules.length === 0 ? NONE_RECORDED : policy.rules.map((rule) => `<code>${e(rule)}</code>`).join(', ')}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

function lcmSection(view: RunView): string {
  return [
    '<section id="lcm">',
    '<h2>LCM</h2>',
    '<dl>',
    `<dt>settings</dt><dd>${recorded(view.lcmSettings)}</dd>`,
    `<dt>degradation</dt><dd>${view.lcmDegraded === null ? NOT_RECORDED : view.lcmDegraded.length === 0 ? NONE_RECORDED : view.lcmDegraded.map(e).join('; ')}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

function unscheduledSection(view: RunView): string {
  const list = (ids: string[] | null): string => ids === null
    ? NOT_RECORDED
    : ids.length === 0 ? NONE_RECORDED : ids.map((id) => `<code>${e(id)}</code>`).join(', ');
  return [
    '<section id="unscheduled">',
    '<h2>Not scheduled</h2>',
    '<dl>',
    `<dt>unscheduled</dt><dd>${list(view.unscheduled)}</dd>`,
    `<dt>deferred writers</dt><dd>${list(view.deferredWriters)}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

function runDocument(view: RunView): string {
  // Nothing below the banner is trusted when the banner is red: the sections would be claims
  // presented as evidence, and the signature is what makes them evidence (SPEC-3.18 §Scope 1).
  const sections = view.banner.kind === 'invalid'
    ? ['<p class="muted">No content is rendered for a record that did not verify.</p>']
    : [
      runSection(view),
      nodesSection(view),
      ...view.nodes.map(nodeSection),
      totalsSection(view),
      policySection(view),
      lcmSection(view),
      unscheduledSection(view),
    ];
  return document(view.banner, `MAF run ${view.runId}`, `Run ${view.runId}`, sections);
}

export interface RenderRunOptions {
  bundleText: string;
  /** What to call the run when the record cannot be read: a run id, or the bundle's file name. */
  label: string;
  signing?: SigningOptions;
  transcriptText?: string;
}

/**
 * Verify first, then render. A record that does not verify renders only the red banner: everything
 * below it would be a claim presented as evidence, and the signature is what makes it evidence.
 */
export function renderRunView(options: RenderRunOptions): string {
  let parsed: AnyBundle;
  try {
    parsed = parseBundle(options.bundleText);
  } catch (err: unknown) {
    return runDocument(invalidRunView(options.label, err instanceof Error ? err.message : String(err)));
  }
  const report = Attestor.report(parsed, options.signing ?? {});
  if (!report.valid) {
    return runDocument(invalidRunView(options.label, report.reason ?? 'The record did not verify.'));
  }
  const view = buildRunView(
    parsed,
    { valid: true, keySource: report.keySource, legacy: report.legacy },
    options.transcriptText,
    options.label,
  );
  return runDocument(view);
}

// ─── Evolver session document ───────────────────────────────────────────────

const SESSION_BANNER: Banner = {
  kind: 'session',
  verdict: 'Evolver session — the report file is the source; it is not a signed run record.',
};

function sessionSection(view: SessionView): string {
  return [
    '<section id="session">',
    '<h2>Session</h2>',
    `<p>stop reason: ${recorded(view.stopReason)}</p>`,
    '<dl>',
    `<dt>ships</dt><dd>${number(view.ships)}</dd>`,
    `<dt>error</dt><dd>${recorded(view.error)}</dd>`,
    `<dt>final harness</dt><dd>${recorded(view.finalHarness)}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

function roundTrainScores(round: SessionView['rounds'][number]): string[] {
  if (round.trainScores === null) return [];
  return [
    '<ul class="train-scores">',
    ...round.trainScores.map((score) => `<li>${e(score.task)}: ${e(score.current)} → ${e(score.candidate)}</li>`),
    '</ul>',
  ];
}

function roundsSection(view: SessionView): string {
  const rows = view.rounds.map((round) => [
    '<tr>',
    `<td>${round.round}</td>`,
    `<td>${e(round.outcome)}</td>`,
    `<td>${recorded(round.candidateSha)}</td>`,
    `<td>${recorded(round.label)}</td>`,
    `<td>${recorded(round.gate)}</td>`,
    `<td>${e(round.note)}</td>`,
    '</tr>',
    ...(round.trainScores === null || round.trainScores.length === 0
      ? []
      : [`<tr><td colspan="6">${roundTrainScores(round).join('')}</td></tr>`]),
  ].join('\n'));
  return [
    '<section id="rounds">',
    `<h2>Rounds (${view.rounds.length})</h2>`,
    '<table>',
    '<thead>',
    '<tr><th>round</th><th>outcome</th><th>candidate</th><th>label</th><th>gate</th><th>note</th></tr>',
    '</thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
    '</section>',
  ].join('\n');
}

function heldOutSection(): string {
  // EvolveReport carries no held-out evidence yet (D-57's second half); the viewer says so rather
  // than presenting the train scores as if they were held out (acceptance 6, AGENTS §4).
  return [
    '<section id="held-out">',
    '<h2>Held-out evidence</h2>',
    '<dl>',
    `<dt>held-out result</dt><dd>${NOT_RECORDED}</dd>`,
    `<dt>test statistic</dt><dd>${NOT_RECORDED}</dd>`,
    `<dt>p-value</dt><dd>${NOT_RECORDED}</dd>`,
    `<dt>contaminated attempts</dt><dd>${NOT_RECORDED}</dd>`,
    '</dl>',
    '</section>',
  ].join('\n');
}

export interface RenderSessionOptions {
  reportText: string;
  label: string;
}

export function renderSessionView(options: RenderSessionOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.reportText);
  } catch {
    // A report that is not JSON has no rounds to show; the section says "not recorded", not zero.
    parsed = null;
  }
  const view = buildSessionView(parsed);
  return document(SESSION_BANNER, `MAF evolve session ${options.label}`, `Evolver session ${options.label}`, [
    sessionSection(view),
    roundsSection(view),
    heldOutSection(),
  ]);
}
