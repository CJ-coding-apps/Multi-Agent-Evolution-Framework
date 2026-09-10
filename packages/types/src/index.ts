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

export function makeRunId(s: string): RunId         { return s as RunId; }
export function makeTaskId(s: string): TaskId       { return s as TaskId; }
export function makeAgentId(s: string): AgentId     { return s as AgentId; }
export function makeToolId(s: string): ToolId       { return s as ToolId; }
export function makeNodeId(s: string): NodeId       { return s as NodeId; }
export function makeBlackboardKey(s: string): BlackboardKey { return s as BlackboardKey; }
export function makeLcmMessageId(s: string): LcmMessageId   { return s as LcmMessageId; }
export function makeLcmSummaryId(s: string): LcmSummaryId   { return s as LcmSummaryId; }
export function makeCommitHash(s: string): CommitHash       { return s as CommitHash; }

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
  agentRole:     string;
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

export interface MemoryGraphApi {
  addNode(n: Omit<MemoryNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
  addEdge(e: Omit<MemoryEdge, 'id' | 'createdAt'>): Promise<string>;
  query(cypher: string, params: Record<string, unknown>): Promise<unknown[]>;
  querySubgraph(taskContext: string, maxNodes: number): Promise<MemorySubgraph>;
  mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<MergeReport>;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLICY ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { verdict: 'Allow' }
  | { verdict: 'Deny';     reason: string; alternative?: ToolId }
  | { verdict: 'Escalate'; reason: string; approvalRequest: ApprovalRequest };

export interface MemoryGraphQuery {
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
  evaluate(toolId: ToolId, input: ToolInput, ctx: ToolContext): Promise<PolicyDecision>;
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
