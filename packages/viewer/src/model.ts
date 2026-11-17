/**
 * The viewer's view model: a pure, tolerant read of a signed record.
 *
 * Every field of the record is optional here except the ones the bundle requires, because the
 * viewer must render every bundle shape since 0.3.1 (SPEC-3.18 acceptance 6) and a reader must
 * never mistake "absent" for "empty" (AGENTS §4). The model records absence as `null`; the
 * renderer turns `null` into the words "not recorded".
 */
import type {
  AttributedChange, ExecutionTierRecord, GoldensSection, KeySource, LcmDegradedRecord,
  LcmSettingsRecord, ModelSurfaceRecord, PolicyInForce, RunOutcome, SecurityFindingsRecord,
  ToolCallRecord, TranscriptEntry,
} from '@maf/types';
import { redactEvidenceText } from '@maf/types';

export interface Banner {
  kind: 'valid' | 'dev' | 'invalid' | 'session';
  verdict: string;
  detail?: string;
}

export interface SurfaceView {
  role: string;
  turn: number;
  tier: string | null;
  kind: string | null;
  systemPromptSha256: string | null;
  promptSha256: string | null;
  stdinSha256: string | null;
  outputSha256: string | null;
  model: string | null;
  error: string | null;
  surfaceSource: string | null;
  reportedTokens: number | null;
}

export interface CallView {
  toolId: string;
  verdict: string;
  ruleId: string | null;
  exitCode: number;
  durationMs: number;
  input: string;
  output: string;
}

export interface NodeView {
  nodeId: string;
  status: string;
  attempt: number;
  role: string | null;
  tier: string | null;
  adapter: string | null;
  fellBackFrom: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureKind: string | null;
  failureDetail: string | null;
  surfaces: SurfaceView[] | null;
  calls: CallView[] | null;
  security: string[] | null;
  lcmSummaryCount: number | null;
  degraded: string[];
  changedPaths: string[] | null;
  modelText: string[] | null;
}

export interface PolicyView {
  ruleCount: number;
  counts: string;
  source: string | null;
  rules: string[];
}

export interface RunView {
  runId: string;
  banner: Banner;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  wallClockMs: number | null;
  diffSubjects: number;
  runFailure: string | null;
  nodesRecorded: boolean;
  nodes: NodeView[];
  peakConcurrency: number | null;
  unscheduled: string[] | null;
  deferredWriters: string[] | null;
  callsByKind: string | null;
  reportedTokens: number | null;
  estimatedTokens: number | null;
  policy: PolicyView | null;
  lcmSettings: string | null;
  lcmDegraded: string[] | null;
  goldens: string | null;
}

export interface SessionRoundView {
  round: number;
  outcome: string;
  note: string;
  label: string | null;
  candidateSha: string | null;
  gate: string | null;
  trainScores: Array<{ task: string; current: string; candidate: string }> | null;
}

export interface SessionView {
  ships: number | null;
  stopReason: string | null;
  error: string | null;
  finalHarness: string | null;
  rounds: SessionRoundView[];
}

/** The union of the two on-disk bundle shapes, read tolerantly. */
type BundleLike = {
  runId?: string;
  keySource?: KeySource;
  toolCalls?: ToolCallRecord[];
  diffHashes?: Record<string, string>;
  securityFindings?: SecurityFindingsRecord[];
  outcome?: RunOutcome;
  policyInForce?: PolicyInForce;
  modelSurfaces?: ModelSurfaceRecord[];
  executionTiers?: ExecutionTierRecord[];
  attributedChanges?: AttributedChange[];
  lcmDegraded?: LcmDegradedRecord[];
  lcmSettings?: LcmSettingsRecord;
  goldens?: GoldensSection;
};

const redacted = (text: string): string => redactEvidenceText(text);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function countTokens(entries: TranscriptEntry[] | null): number | null {
  if (entries === null) return null;
  return entries.reduce((sum, entry) => sum + (Number.isFinite(entry.tokens) ? entry.tokens : 0), 0);
}

function joinByStart(nodes: NodeView[]): NodeView[] {
  return [...nodes].sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return a.startedAt < b.startedAt ? -1 : 1;
    }
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

/** The largest number of node intervals that overlap, or null when no interval is recorded. */
function peakConcurrency(nodes: NodeView[]): number | null {
  const events: Array<{ at: number; delta: number }> = [];
  let seen = false;
  for (const node of nodes) {
    if (node.startedAt === null || node.finishedAt === null) continue;
    const from = Date.parse(node.startedAt);
    const to = Date.parse(node.finishedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    seen = true;
    events.push({ at: from, delta: 1 }, { at: to, delta: -1 });
  }
  if (!seen) return null;
  // A finish at the same instant as a start is not an overlap: process the -1 first.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function span(nodes: NodeView[]): { startedAt: string | null; finishedAt: string | null; wallClockMs: number | null } {
  const starts = nodes.map((n) => n.startedAt).filter((v): v is string => v !== null);
  const ends = nodes.map((n) => n.finishedAt).filter((v): v is string => v !== null);
  const startedAt = starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  const finishedAt = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null;
  if (startedAt === null || finishedAt === null) return { startedAt, finishedAt, wallClockMs: null };
  const from = Date.parse(startedAt);
  const to = Date.parse(finishedAt);
  return {
    startedAt,
    finishedAt,
    wallClockMs: Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null,
  };
}

function surfaceView(record: ModelSurfaceRecord): SurfaceView {
  return {
    role: record.role,
    turn: record.turn,
    tier: record.tier ?? null,
    kind: record.kind ?? null,
    systemPromptSha256: record.systemPromptSha256 || null,
    promptSha256: record.promptSha256 ?? null,
    stdinSha256: record.stdinSha256 ?? null,
    outputSha256: record.outputSha256 ?? null,
    model: record.model ?? null,
    error: record.error ?? null,
    surfaceSource: record.surfaceSource ?? null,
    reportedTokens: record.lcmSummary?.reportedTokens ?? null,
  };
}

function callView(call: ToolCallRecord): CallView {
  const decision = call.policyDecision;
  const ruleId = 'ruleId' in decision ? decision.ruleId ?? null : null;
  return {
    toolId: String(call.toolId),
    verdict: decision.verdict,
    ruleId,
    exitCode: call.result.exitCode,
    durationMs: call.durationMs,
    input: redacted(JSON.stringify(call.input)),
    output: redacted([call.result.stdout, call.result.stderr].filter((s) => s.length > 0).join('\n')),
  };
}

function nodeView(
  execution: NonNullable<RunOutcome['nodes']>[number],
  bundle: BundleLike,
  transcript: TranscriptEntry[] | null,
): NodeView {
  const nodeId = String(execution.nodeId);
  const tier = bundle.executionTiers?.find((t) => t.nodeId === nodeId);
  const surfaces = bundle.modelSurfaces?.filter((s) => String(s.taskId) === nodeId);
  const calls = bundle.toolCalls?.filter((c) => String(c.taskId) === nodeId);
  const findings = bundle.securityFindings?.filter((f) => f.nodeId === nodeId);
  const paths = bundle.diffHashes
    ? Object.keys(bundle.diffHashes).filter((name) => name === `${nodeId}.diff` || name.startsWith(`${nodeId}.`))
    : null;
  const failure = execution.failure;
  const failureDetail = failure === undefined
    ? null
    : `${failure.kind}${failure.ruleId ? ` (rule ${failure.ruleId})` : ''}${failure.toolId ? ` (tool ${failure.toolId})` : ''}`;
  const text = transcript === null
    ? null
    : transcript
      .filter((entry) => entry.role === 'assistant' && entry.metadata?.['nodeId'] === nodeId)
      .map((entry) => redacted(entry.content));
  return {
    nodeId,
    status: execution.status,
    attempt: execution.attempt,
    role: tier?.role ?? null,
    tier: tier?.tier ?? null,
    adapter: tier?.adapter ?? null,
    fellBackFrom: tier?.fellBackFrom ?? null,
    startedAt: execution.startedAt ? new Date(execution.startedAt).toISOString() : null,
    finishedAt: execution.finishedAt ? new Date(execution.finishedAt).toISOString() : null,
    failureKind: failure?.kind ?? null,
    failureDetail,
    surfaces: surfaces === undefined ? null : surfaces.map(surfaceView),
    calls: calls === undefined ? null : calls.map(callView),
    security: findings === undefined
      ? null
      : findings.map((f) => {
        const result = f.result as { passed?: boolean; findings?: unknown[]; summary?: string };
        const count = Array.isArray(result.findings) ? result.findings.length : 0;
        const verdict = result.passed === true ? 'passed' : result.passed === false ? 'failed' : 'not recorded';
        return `${verdict} (${count} findings)${result.summary ? `: ${redacted(result.summary)}` : ''}`;
      }),
    lcmSummaryCount: surfaces === undefined ? null : surfaces.filter((s) => s.lcmSummary !== undefined).length,
    degraded: (bundle.lcmDegraded ?? [])
      .filter((record) => record.nodeId === nodeId)
      .map((record) => `${record.reason}${record.tokens !== undefined ? ` (${record.tokens} tokens)` : ''}`),
    changedPaths: paths === null ? null : paths.map(redacted),
    modelText: text,
  };
}

function callsByKind(calls: ToolCallRecord[] | undefined): string | null {
  if (calls === undefined) return null;
  const counts = new Map<string, number>();
  for (const call of calls) {
    const id = String(call.toolId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, n]) => `${id}=${n}`).join(', ');
}

function policyView(policy: PolicyInForce | undefined): PolicyView | null {
  if (policy === undefined) return null;
  const counts = policy.counts;
  return {
    ruleCount: policy.ruleCount,
    counts: `allow ${counts.allow}, deny ${counts.deny}, escalate ${counts.escalate}, indeterminate ${counts.indeterminate}`,
    source: policy.source !== undefined
      ? redacted(policy.source)
      : policy.sourceKind !== undefined ? policy.sourceKind : null,
    rules: policy.rules.map((rule) => `${redacted(rule.id)} ${redacted(rule.effect)} ${redacted(rule.matcher)}`),
  };
}

function lcmSettingsView(settings: LcmSettingsRecord | undefined): string | null {
  if (settings === undefined) return null;
  const parts = [
    `mode ${settings.mode}`,
    `operator ${settings.operator}`,
    `contextThreshold ${settings.contextThreshold}`,
    `freshTailCount ${settings.freshTailCount}`,
    `summaryTimeoutMs ${settings.summaryTimeoutMs}`,
  ];
  if (settings.model !== undefined) parts.push(`model ${settings.model}`);
  return parts.join(', ');
}

function degradedView(records: LcmDegradedRecord[] | undefined): string[] | null {
  // The type documents absence as "no degradation": F5 records every failure before continuing.
  if (records === undefined) return [];
  return records.map((r) => `${r.reason}${r.tokens !== undefined ? ` (${r.tokens} tokens)` : ''}`);
}

/** A bundle whose JSON parsed but whose signature did not verify (or could not be read). */
export function invalidRunView(label: string, reason: string): RunView {
  return {
    runId: label,
    banner: { kind: 'invalid', verdict: 'NOT VERIFIED: this record is not trusted.', detail: reason },
    status: null,
    startedAt: null,
    finishedAt: null,
    wallClockMs: null,
    diffSubjects: 0,
    runFailure: null,
    nodesRecorded: false,
    nodes: [],
    peakConcurrency: null,
    unscheduled: null,
    deferredWriters: null,
    callsByKind: null,
    reportedTokens: null,
    estimatedTokens: null,
    policy: null,
    lcmSettings: null,
    lcmDegraded: null,
    goldens: null,
  };
}

export interface RunVerification {
  valid: boolean;
  keySource: KeySource;
  legacy: boolean;
  reason?: string;
}

export function buildRunView(
  bundle: unknown,
  verification: RunVerification,
  transcriptText: string | undefined,
  label: string,
): RunView {
  const statement = bundle as { predicate?: unknown };
  const source = statement !== null && typeof statement === 'object' && 'predicate' in statement ? statement.predicate : bundle;
  // A statement whose predicate is null or a primitive still parses; read it as empty, not crash.
  const record = (source !== null && typeof source === 'object' ? source : {}) as BundleLike;
  const transcript = transcriptText === undefined ? null : parseTranscript(transcriptText);
  const executions = record.outcome?.nodes ?? undefined;
  const nodes = executions === undefined
    ? []
    : executions.map((execution) => nodeView(execution, record, transcript));
  const ordering = joinByStart(nodes);
  const spanView = span(nodes);
  const reported = record.modelSurfaces === undefined
    ? null
    : record.modelSurfaces.reduce((sum, surface) => sum + (surface.lcmSummary?.reportedTokens ?? 0), 0);
  const banner: Banner = verification.valid
    ? verification.keySource === 'dev'
      ? { kind: 'dev', verdict: 'VERIFIED — signed with the public development key (no evidence of authorship).' }
      : { kind: 'valid', verdict: 'VERIFIED — signed with a key of your own (MAF_SIGNING_KEY).' }
    : { kind: 'invalid', verdict: 'NOT VERIFIED: this record is not trusted.', ...(verification.reason !== undefined ? { detail: verification.reason } : {}) };
  const failure = record.outcome?.failure;
  return {
    runId: record.runId !== undefined ? String(record.runId) : label,
    banner,
    status: record.outcome?.status ?? null,
    startedAt: spanView.startedAt,
    finishedAt: spanView.finishedAt,
    wallClockMs: spanView.wallClockMs,
    diffSubjects: record.diffHashes === undefined ? 0 : Object.keys(record.diffHashes).length,
    runFailure: failure === undefined
      ? null
      : `${failure.kind}${failure.ruleId ? ` (rule ${failure.ruleId})` : ''}${failure.toolId ? ` (tool ${failure.toolId})` : ''}`,
    nodesRecorded: executions !== undefined,
    nodes: ordering,
    peakConcurrency: peakConcurrency(ordering),
    unscheduled: record.outcome?.unscheduled ?? null,
    deferredWriters: record.outcome?.deferredWriters ?? null,
    callsByKind: callsByKind(record.toolCalls),
    reportedTokens: reported,
    estimatedTokens: countTokens(transcript),
    policy: policyView(record.policyInForce),
    lcmSettings: lcmSettingsView(record.lcmSettings),
    lcmDegraded: degradedView(record.lcmDegraded),
    goldens: record.goldens === undefined
      ? null
      : `${record.goldens.harnessId} (${record.goldens.solvedTaskIds.length}/${record.goldens.total} solved)`,
  };
}

function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as TranscriptEntry;
      if (parsed !== null && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // A malformed transcript line is not evidence of a turn; it is skipped, never guessed at.
    }
  }
  return entries;
}

// ─── Evolver session ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function scoreOf(scores: unknown, taskId: string): string {
  const record = asObject(scores);
  const solved = record !== null && Array.isArray(record['solvedTaskIds']) ? record['solvedTaskIds'] : [];
  return solved.includes(taskId) ? 'solved' : 'failed';
}

function taskIds(scores: unknown): string[] {
  const record = asObject(scores);
  const tasks = record !== null ? asArray(record['tasks']) : [];
  return tasks
    .map((task) => str(asObject(task)?.['taskId']))
    .filter((id): id is string => id !== null)
    .sort();
}

function gateOf(gate: unknown): string | null {
  const record = asObject(gate);
  if (record === null) return null;
  const verdict = str(record['verdict']);
  if (verdict === null) return null;
  const stage = str(record['stage']);
  const reason = str(record['reason']);
  const improvements = asArray(record['improvements']).filter((v): v is string => typeof v === 'string');
  if (stage !== null) return `${verdict} (${stage})${reason !== null ? `: ${redacted(reason)}` : ''}`;
  if (reason !== null) return `${verdict}: ${redacted(reason)}`;
  if (improvements.length > 0) return `${verdict}: improves ${improvements.map(redacted).join(', ')}`;
  return verdict;
}

function roundView(round: unknown): SessionRoundView {
  const record = asObject(round) ?? {};
  const evaluation = asObject(record['evaluation']);
  const current = evaluation?.['currentScores'];
  const candidate = evaluation?.['candidateScores'];
  const tasks = evaluation === null || evaluation === undefined
    ? []
    : [...new Set([...taskIds(current), ...taskIds(candidate)])].sort();
  const manifest = asObject(record['manifest']);
  return {
    round: num(record['round']) ?? 0,
    outcome: str(record['outcome']) ?? 'not recorded',
    note: str(record['note']) ?? 'not recorded',
    label: manifest === null ? null : str(manifest['summary']),
    candidateSha: evaluation === null || evaluation === undefined ? null : str(evaluation['candidateSha']),
    gate: gateOf(record['gate']),
    trainScores: evaluation === null || evaluation === undefined
      ? null
      : tasks.map((task) => ({ task, current: scoreOf(current, task), candidate: scoreOf(candidate, task) })),
  };
}

export function buildSessionView(report: unknown): SessionView {
  const record = asObject(report) ?? {};
  const finalHarness = asObject(record['finalHarness']);
  return {
    ships: num(record['ships']),
    stopReason: str(record['stopReason']),
    error: str(record['error']),
    finalHarness: finalHarness === null || finalHarness === undefined
      ? null
      : `${str(finalHarness['id']) ?? 'not recorded'} (${str(finalHarness['sha']) ?? 'not recorded'})`,
    rounds: asArray(record['rounds']).map(roundView),
  };
}
