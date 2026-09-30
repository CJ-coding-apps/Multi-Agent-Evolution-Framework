// ─────────────────────────────────────────────────────────────────────────────
// BRANDED IDs — zero-cost type safety
// ─────────────────────────────────────────────────────────────────────────────

export type RunId         = string & { readonly _brand: 'RunId' };
export type TaskId        = string & { readonly _brand: 'TaskId' };
export type AgentId       = string & { readonly _brand: 'AgentId' };
export type ToolId        = string & { readonly _brand: 'ToolId' };
export type NodeId        = string & { readonly _brand: 'NodeId' };
export type EdgeId        = string & { readonly _brand: 'EdgeId' };
export type BlackboardKey = string & { readonly _brand: 'BlackboardKey' };
export type LcmMessageId  = string & { readonly _brand: 'LcmMessageId' };
export type LcmSummaryId  = string & { readonly _brand: 'LcmSummaryId' };
export type CommitHash    = string & { readonly _brand: 'CommitHash' };
/**
 * A role name that a role set defines.
 *
 * Deliberately NOT mintable here: there is no `makeRoleName`, because "this name exists"
 * is a fact only a role set can establish, and the role registry is what holds one. A
 * `RoleName` is obtained either from `RoleRegistry.resolve` (validated against the set in
 * force) or from `RoleConfig.role` (already in a set) — so a hallucinated or misspelled
 * name cannot reach a `DagNode` at all. D-07 was the opposite: an unknown name silently
 * became the default `coder`, which widened privilege rather than refusing it.
 */
export type RoleName      = string & { readonly _brand: 'RoleName' };

/**
 * What a graph node id may be. Validated at construction, not trusted from the source.
 *
 * The cast this replaces was applied straight to planner JSON, so a model-authored id of any
 * shape reached every place a node id is used. D-08's repro was an id that ended the surrounding
 * Cypher string literal and dropped the whole graph. Real parameter binding (see `GraphQuery`)
 * is what removes the injection; this is the second half — a node id is now a value with a
 * known shape, so it is also safe as a map key, a transcript label or a filename stem.
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function makeRunId(s: string): RunId         { return s as RunId; }
export function makeTaskId(s: string): TaskId       { return s as TaskId; }
export function makeAgentId(s: string): AgentId     { return s as AgentId; }
export function makeToolId(s: string): ToolId       { return s as ToolId; }
export function makeNodeId(s: string): NodeId {
  if (!NODE_ID_PATTERN.test(s)) {
    throw new Error(
      `Invalid NodeId ${JSON.stringify(s)}: a node id is 1-128 characters of A-Z a-z 0-9 _ or -`,
    );
  }
  return s as NodeId;
}
export function makeBlackboardKey(s: string): BlackboardKey { return s as BlackboardKey; }
export function makeLcmMessageId(s: string): LcmMessageId   { return s as LcmMessageId; }
export function makeLcmSummaryId(s: string): LcmSummaryId   { return s as LcmSummaryId; }
export function makeCommitHash(s: string): CommitHash       { return s as CommitHash; }

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — a lookup that can fail, where the failure is the caller's to handle
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never>  { return { ok: true, value }; }
export function err<E>(error: E): Result<never, E>  { return { ok: false, error }; }

/**
 * A name no role set in force defines. Carries the names that *do* exist, because the
 * caller's next move is usually to say so — "unknown role \"read-only-auditor\"; known
 * roles are: coder, tester, …" — and a bare "unknown" makes the operator guess.
 */
export interface UnknownRole {
  readonly requested: string;
  readonly known:     readonly RoleName[];
}

/**
 * The two questions a DAG builder must ask of whoever owns the roles: which name does a
 * node without one get, and is this name real? Implemented by `RoleRegistry`; declared
 * here so `@maf/dag-runner` and `@maf/planning-agent` can build nodes without depending
 * on the registry package (or being able to invent a role name themselves).
 */
export interface RoleResolver {
  readonly defaultRole: RoleName;
  resolveRole(raw: string): Result<RoleName, UnknownRole>;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL PLUGIN
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionLevel = 'read' | 'write' | 'execute' | 'dangerous';

export type ToolInput = { [key: string]: unknown };

export interface ToolResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
  duration: number;
  metadata: Record<string, unknown>;
}

export interface ToolCallRecord {
  id:             string;
  toolId:         ToolId;
  agentId:        AgentId;
  runId:          RunId;
  taskId:         TaskId;
  input:          ToolInput;
  result:         ToolResult;
  invokedAt:      Date;
  durationMs:     number;
  policyDecision: PolicyDecision;
}

export interface ToolContext {
  cwd:           string;
  projectRoot:   string;
  runId:         RunId;
  taskId:        TaskId;
  agentId:       AgentId;
  worktreePath?: string;
  sessionId:     string;
  agentRole?:    string;
  policy:        PolicyEngineHandle;
  attestor:      AttestorHandle;
}

export interface ToolPlugin<I extends ToolInput = ToolInput> {
  readonly id:     ToolId;
  name:            string;
  description:     string;
  permissionLevel: PermissionLevel;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;

  /**
   * The filesystem paths this call will touch, as the tool itself declares them.
   *
   * MUST be a pure function of `input`: the policy layer calls it before any rule and
   * before `execute`, so a tool that only reveals its paths while running (patch.apply
   * derived them inside `execute` and wrote them back onto the input) is invisible to
   * path rules — the shipped `protect-secrets` Deny matched `fs.write ".env"` and skipped
   * `patch.apply` on the same file.
   *
   * MUST over-declare rather than under-declare: a path that is declared but never touched
   * can only make a rule match sooner, while a path that is touched but not declared is a
   * silent Allow. A tool with no filesystem surface returns `[]`.
   */
  declaredPaths(input: I): string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// DAG RUNNER
// ─────────────────────────────────────────────────────────────────────────────

export type DagNodeStatus =
  | 'Unclaimed'
  | 'Claimed'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Skipped';

export interface DagNode {
  id:            NodeId;
  label:         string;
  /** A name a role set defines — see {@link RoleName}. */
  agentRole:     RoleName;
  dependencies:  NodeId[];
  retryPolicy:   RetryPolicy;
  timeoutMs:     number;
  inputs:        Record<string, BlackboardKey>;
  outputs:       Record<string, BlackboardKey>;
  metadata:      Record<string, unknown>;
}

export interface DagEdge {
  id:   EdgeId;
  from: NodeId;
  to:   NodeId;
  kind: 'data' | 'control' | 'review';
}

export interface Dag {
  id:     string;
  runId:  RunId;
  nodes:  Map<NodeId, DagNode>;
  edges:  DagEdge[];
  config: DagConfig;
}

export interface DagConfig {
  maxConcurrent:     number;
  retryPolicy:       RetryPolicy;
  timeoutMs:         number;
  reviewGateNodeIds: NodeId[];
}

/** 'Unschedulable' is a real verdict: the DAG was valid but never ran to completion. */
export type RunStatus = 'Succeeded' | 'Failed' | 'Unschedulable';

export interface RunOutcome {
  status:      RunStatus;
  /** Per-node results — present when the run was a DAG. */
  nodes?:      DagNodeExecution[];
  /** Nodes that never ran: a dependency failed, was skipped, or was unreachable. */
  unscheduled: NodeId[];
  /** Nodes held back because another writer held the working tree at the time. */
  deferredWriters?: NodeId[];
}

export interface RetryPolicy {
  maxAttempts:   number;
  backoffMs:     number;
  backoffFactor: number;
  jitterMs:      number;
}

export interface DagNodeExecution {
  nodeId:      NodeId;
  runId:       RunId;
  status:      DagNodeStatus;
  attempt:     number;
  claimedAt?:  Date;
  startedAt?:  Date;
  finishedAt?: Date;
  error?:      string;
  agentId?:    AgentId;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLACKBOARD
// ─────────────────────────────────────────────────────────────────────────────

export type BlackboardValue =
  | { kind: 'string';  value: string }
  | { kind: 'json';    value: unknown }
  | { kind: 'buffer';  value: Uint8Array }
  | { kind: 'ref';     key: BlackboardKey };

export interface BlackboardEntry {
  key:        BlackboardKey;
  value:      BlackboardValue;
  producedBy: NodeId;
  runId:      RunId;
  createdAt:  Date;
  ttlMs?:     number;
}

export interface BlackboardSnapshot {
  runId:    RunId;
  timestamp: Date;
  entries:   BlackboardEntry[];
  dagState:  Map<NodeId, DagNodeStatus>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LCM — LOSSLESS CONTEXT MEMORY
// ─────────────────────────────────────────────────────────────────────────────

export type LcmMode = 'Dolt' | 'Upward';

export interface LcmMessage {
  id:         LcmMessageId;
  sessionId:  string;
  runId:      RunId;
  role:       'user' | 'assistant' | 'system' | 'tool';
  content:    string;
  tokens:     number;
  createdAt:  Date;
  parentId?:  LcmMessageId;
  summaryId?: LcmSummaryId;
}

export interface LcmSummary {
  id:         LcmSummaryId;
  parentIds:  LcmSummaryId[];
  messageIds: LcmMessageId[];
  content:    string;
  tokens:     number;
  level:      number;
  createdAt:  Date;
  operator:   'LLM-Map' | 'Agentic-Map';
}

export interface GhostCue {
  summaryId:  LcmSummaryId;
  cueText:    string;
  relevance:  number;
}

export interface LcmContext {
  messages:    LcmMessage[];
  ghosts:      GhostCue[];
  totalTokens: number;
}

export interface LcmApi {
  addMessage(msg: Omit<LcmMessage, 'id' | 'createdAt'>): Promise<LcmMessageId>;
  summarizeChunk(
    messageIds: LcmMessageId[],
    operator: 'LLM-Map' | 'Agentic-Map'
  ): Promise<LcmSummaryId>;
  assembleContext(
    sessionId: string,
    tokenBudget: number,
    mode?: LcmMode
  ): Promise<LcmContext>;
  lcm_grep(query: string, sessionId: string): Promise<LcmMessage[]>;
  lcm_expand(summaryId: LcmSummaryId): Promise<LcmMessage[]>;
  mergeRuns(runIds: RunId[], targetRunId: RunId): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY GRAPH
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryNodeKind =
  | 'Run'
  | 'Task'
  | 'File'
  | 'Symbol'
  | 'ToolInvocation'
  | 'PolicyEvent'
  | 'Failure'
  | 'Approval'
  | 'Attestation'
  | 'GoldenResult'
  | 'EvolutionRound';

export type MemoryRelation =
  | 'PRODUCED'
  | 'MODIFIED'
  | 'CAUSED_FAILURE'
  | 'RESOLVED_BY'
  | 'DEPENDS_ON'
  | 'SUMMARIZED_INTO'
  | 'APPROVED_BY'
  | 'ATTESTED_BY'
  | 'MERGED_FROM'
  | 'SCORED_BY';

export interface MemoryNode {
  id:         string;
  kind:       MemoryNodeKind;
  label:      string;
  properties: Record<string, unknown>;
  runId:      RunId;
  createdAt:  Date;
  updatedAt:  Date;
}

export interface MemoryEdge {
  id:        string;
  fromId:    string;
  toId:      string;
  relation:  MemoryRelation;
  weight:    number;
  metadata:  Record<string, unknown>;
  createdAt: Date;
}

export interface MemorySubgraph {
  nodes:            MemoryNode[];
  edges:            MemoryEdge[];
  queryContext:     string;
  relevanceScores:  Map<string, number>;
}

export interface MergeReport {
  nodesCreated:   number;
  edgesCreated:   number;
  conflictsFound: string[];
  mergedAt:       Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH QUERIES — one value object, and its values are bound, never written in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a graph query may bind. Deliberately narrow, because it is exactly what both backends
 * accept as a parameter: Kùzu 0.7.x takes boolean/number/string/Date/BigInt and nothing else —
 * no arrays, no `null`, no objects. An array is bound as one parameter per element under
 * generated names (`$id0, $id1, …`); `LIMIT` and a variable-length path's hop count cannot be
 * parameters in either query language and stay validated integer literals.
 */
export type QueryParamValue = string | number | boolean | Date;
export type QueryParams     = Readonly<Record<string, QueryParamValue>>;

/**
 * A query and the values it binds. This is the only way a value enters a query: there is no
 * escaper, because there is nothing to escape. The type exists so that "what is the query?" and
 * "what did it bind?" cannot be answered separately — the escaper that D-08 found lived, in
 * three identical copies, in the gap between those two answers.
 */
export interface GraphQuery {
  readonly cypher: string;
  readonly params: QueryParams;
}

export type GraphRow = Record<string, unknown>;

/**
 * What graph *consumers* depend on — the policy engine, the injector, the digester. Narrow on
 * purpose: a consumer that can only run a `GraphQuery` cannot build one by concatenation, and a
 * different backend is a new implementation of this rather than an edit to every call site.
 *
 * An error is thrown, never answered with an empty result: "the graph could not answer" and
 * "the graph answered nothing" are different facts, and a rule that is skipped on the first is
 * a rule that stops firing whenever an attacker can break the graph.
 */
export interface GraphQueryRunner {
  run(query: GraphQuery): Promise<GraphRow[]>;
}

export interface MemoryGraphApi extends GraphQueryRunner {
  addNode(n: Omit<MemoryNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
  addEdge(e: Omit<MemoryEdge, 'id' | 'createdAt'>): Promise<string>;
  querySubgraph(taskContext: string, maxNodes: number): Promise<MemorySubgraph>;
  mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<MergeReport>;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLICY ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { verdict: 'Allow' }
  | { verdict: 'Deny';     reason: string; alternative?: ToolId }
  | { verdict: 'Escalate'; reason: string; approvalRequest: ApprovalRequest }
  /**
   * The policy could not be evaluated, so no verdict about the call is available — and the call
   * does not proceed. Today this is one thing: a rule's `memoryPattern` query failed, so a
   * `Deny` rule that might have matched did not get to say so. Answering `Allow` there is the
   * fail-open D-08 names, and it is the easiest state for an attacker to induce (break the
   * graph, then act). Distinct from `Escalate`: nothing is being asked of a human, because
   * there is no decision to approve.
   */
  | { verdict: 'Indeterminate'; reason: string; ruleId?: string };

export interface MemoryGraphQuery {
  /**
   * A Cypher template for the rule's graph half. It may name any of `$tool`, `$path`, `$runId`
   * and `$taskId`; those are bound as real parameters, so the template stays a template and the
   * values never become part of the query text.
   */
  cypher: string;
}

export interface PolicyPredicate {
  toolId?:           ToolId | ToolId[];
  pathGlob?:         string;
  allowedPathGlobs?: string[];
  agentRole?:        string | string[];
  memoryPattern?:    MemoryGraphQuery;
  minFailureCount?:  number;
}

export type PolicyAction =
  | { kind: 'Allow' }
  | { kind: 'Deny';     reason: string; alternative?: ToolId }
  | { kind: 'Escalate'; requiresApproval: boolean };

export interface PolicyRule {
  id:          string;
  description: string;
  predicate:   PolicyPredicate;
  action:      PolicyAction;
  priority:    number;
}

export interface PolicyEngineHandle {
  /**
   * `declaredPaths` is the calling tool's own `ToolPlugin.declaredPaths(input)` for this
   * input — required, not optional, so no call site can leave path rules with nothing to
   * match against. See the note on `ToolPlugin.declaredPaths`.
   */
  evaluate(
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
    declaredPaths: readonly string[],
  ): Promise<PolicyDecision>;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL GATE
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id:           string;
  runId:        RunId;
  taskId:       TaskId;
  requestedBy:  AgentId;
  toolId?:      ToolId;
  policyRuleId: string;
  description:  string;
  diff?:        string;
  prUrl?:       string;
  createdAt:    Date;
  expiresAt?:   Date;
}

export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'TimedOut';

export interface ApprovalDecision {
  requestId:  string;
  status:     ApprovalStatus;
  reviewer:   string;
  comment?:   string;
  decidedAt:  Date;
  signature?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTESTATION — SLSA-style
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewAttestation {
  requestId:    string;
  decision:     ApprovalDecision;
  commitHash:   CommitHash;
  diffHash:     string;
  intotoStmt:   string;
}

export interface SlsaBuilder {
  id:           string;
  modelVersion: string;
}

export interface SlsaMaterial {
  uri:    string;
  digest: { sha256: string };
}

export interface SlsaInvocation {
  configSource: SlsaMaterial;
  parameters:   Record<string, unknown>;
  environment:  Record<string, unknown>;
}

export interface SlsaRunEnvironment {
  platform:    string;
  nodeVersion: string;
  timestamp:   string;
}

export interface SlsaProvenance {
  buildType:  string;
  builder:    SlsaBuilder;
  invocation: SlsaInvocation;
  materials:  SlsaMaterial[];
  runEnv:     SlsaRunEnvironment;
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  severity:    SecuritySeverity;
  category:    string;
  file:        string;
  line?:       number;
  rationale:   string;
  remediation: string;
}

export interface SecurityReviewResult {
  findings: SecurityFinding[];
  summary:  string;
  passed:   boolean;
}

export interface SecurityFindingsRecord {
  nodeId: string;
  result: SecurityReviewResult;
}

export interface GoldensSection {
  harnessSha:      string;
  harnessId:       string;
  solvedTaskIds:   string[];
  total:           number;
  ranAt:           string;
}

export interface AttestationBundle {
  runId:             RunId;
  provenance:        SlsaProvenance;
  toolCalls:         ToolCallRecord[];
  approvals:         ReviewAttestation[];
  diffHashes:        Record<string, string>;
  securityFindings?: SecurityFindingsRecord[];
  /**
   * Verdict for the run this bundle attests. Required — a bundle that cannot say
   * whether its run succeeded is precisely the defect this field exists to stop.
   */
  outcome:           RunOutcome;
  /** Golden-suite outcome for the harness under test (eval-harness runs only). */
  goldens?:          GoldensSection;
  signature:         string;
  bundledAt:         Date;
}

export interface AttestorHandle {
  record(call: Omit<ToolCallRecord, 'id'>): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ADAPTER
// ─────────────────────────────────────────────────────────────────────────────

export type AdapterName = 'claude' | 'gemini' | 'codex' | 'ollama' | 'openrouter' | string;

export interface AdapterCapabilities {
  supportsStreaming:   boolean;
  supportsToolCalling: boolean;
  supportsWorktrees:   boolean;
  /** True when the adapter implements `TurnAdapter.sendTurn` (in-process loop). */
  inProcessLoop:       boolean;
  maxConcurrentTasks:  number;
  nativePlugins:       string[];
}

export interface AdapterInvokeOptions {
  prompt:           string;
  systemPrompt?:    string;
  tools?:           ToolPlugin[];
  workingDir:       string;
  timeoutMs:        number;
  tokenBudget?:     number;
  model?:           string;
  maxOutputBytes?:  number;
  /** Pinned sampling temperature when the backend supports it (golden determinism).
   *  Adapters that cannot control temperature MUST ignore it, never error. */
  temperature?:     number;
}

export interface AdapterInvokeResult {
  success:     boolean;
  output:      string;
  tokensUsed?: number;
  toolCallLog: ToolCallRecord[];
  exitCode:    number;
  duration:    number;
}

export interface CliAdapter {
  readonly name: AdapterName;
  capabilities(): AdapterCapabilities;
  isAvailable(): Promise<boolean>;
  invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult>;
  stream(options: AdapterInvokeOptions): AsyncGenerator<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIPT
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  id:        string;
  runId:     RunId;
  agentId:   AgentId;
  role:      'user' | 'assistant' | 'system' | 'tool';
  content:   string;
  tokens:    number;
  timestamp: Date;
  metadata:  Record<string, unknown>;
}

export interface CompressionResult {
  originalTokens:   number;
  compressedTokens: number;
  summaryId:        LcmSummaryId;
  ratio:            number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL LOOP
// ─────────────────────────────────────────────────────────────────────────────

export type LoopPhase =
  | 'Initializing'
  | 'Planning'
  | 'Executing'
  | 'Testing'
  | 'Evaluating'
  | 'Retrying'
  | 'Done'
  | 'Failed';

export interface LoopState {
  runId:        RunId;
  taskId:       TaskId;
  phase:        LoopPhase;
  attempt:      number;
  tokensBudget: number;
  tokensUsed:   number;
  errorCount:   number;
  lastCommit?:  CommitHash;
  startedAt:    Date;
  updatedAt:    Date;
}

export interface CircuitBreakerConfig {
  maxAttempts:      number;
  maxErrors:        number;
  tokenBudget:      number;
  callsPerHour:     number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TURN ADAPTER — turn-level model access for the in-process loop (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCallRequest {
  /** Correlation id echoed back by the matching tool TurnMessage. */
  toolUseId: string;
  toolName:  string;
  input:     ToolInput;
}

export type TurnMessage =
  | { kind: 'user';      text: string }
  | { kind: 'assistant'; text: string; toolCalls: ToolCallRequest[] }
  | { kind: 'tool';      toolUseId: string; toolName: string; content: string; isError?: boolean };

export interface AssistantTurn {
  text:         string;
  toolCalls:    ToolCallRequest[];
  tokensUsed?:  number;
  /** Raw backend output for diagnostics/attestation (not shown to other processors). */
  raw?:         string;
  /**
   * Per-block parse failures when decoding the tool-call wire protocol — e.g. a
   * fenced `tool_call` block that was not valid JSON or lacked a string toolName.
   * The in-process loop uses this to drive a bounded repair/retry (rather than
   * silently dropping the model's botched tool call). Omitted when there are none.
   */
  parseErrors?: string[];
}

/**
 * TurnAdapter — implemented by adapters that can drive a multi-turn conversation
 * with explicit tool-call round-tripping, letting MAF's policy engine and
 * processor pipeline intercept EVERY tool call (the legacy CliAdapter.invoke
 * path dispatches one opaque invocation where tools are advisory).
 *
 * Pre-approved cross-package interface decision per HARNESSX_INTEGRATION_PLAN.md §10.5.
 */
export interface TurnAdapter extends CliAdapter {
  sendTurn(history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn>;
}

export function isTurnAdapter(a: CliAdapter): a is TurnAdapter {
  return typeof (a as Partial<TurnAdapter>).sendTurn === 'function';
}

/**
 * Coarse token estimate (~4 chars/token) for budget enforcement when a backend
 * does not report real usage. CLI adapters (claude/codex) never populate
 * AssistantTurn.tokensUsed, so the in-process loop falls back to this to make
 * role.tokenBudget a real stop rather than a no-op. Deliberately an over-estimate
 * on the safe side (fail-fast), never negative.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
