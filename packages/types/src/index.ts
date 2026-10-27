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

  /**
   * The declaration the policy approved for this call, when it was approved.
   *
   * `executeToolGated` sets it on the context it hands `execute` and nowhere else, so the policy
   * and the approval gate see the caller's own context. A tool whose declaration can be recomputed
   * where it acts must compare the two and refuse when they differ: an approval is of a set of
   * paths, and a call that would write a different set was never approved. The set is frozen, so no
   * holder of a handle to it can change what was approved.
   *
   * Absent means the call did not come through the gate — a caller that is not the gate, or a test
   * calling `execute` directly — and a write is refused: there is no approved set to compare with,
   * and a write nothing approved is not an allowed one. A direct call that is meant to write names
   * the paths it was approved for; the tests do.
   */
  approvedPaths?: readonly string[];
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
   * MUST be a pure function of `input` and, where given, `ctx`: the same input and the same
   * context must always give the same declaration. The policy layer calls it before any rule and
   * before `execute`, so a tool that only reveals its paths while running (patch.apply derived
   * them inside `execute` and wrote them back onto the input) is invisible to path rules — the
   * shipped `protect-secrets` Deny matched `fs.write ".env"` and skipped `patch.apply` on the
   * same file.
   *
   * `ctx` is optional and is the caller's own context, without `approvedPaths`. It is there for a
   * declaration that has to read the tree — a name that is a symlink today, say — so the gate can
   * record a refusal instead of an Allow that `execute` then declines. A tool that does not read
   * the tree ignores it and must behave the same with and without it.
   *
   * MUST over-declare rather than under-declare: a path that is declared but never touched
   * can only make a rule match sooner, while a path that is touched but not declared is a
   * silent Allow. A tool with no filesystem surface returns `[]`.
   *
   * Declared paths are relative to the project root, and must stay inside it. The policy engine
   * resolves each one with `resolveInside(ctx.projectRoot, …)` before any rule sees it, so a
   * glob is matched against the real file rather than against whatever spelling the caller used,
   * and a path that leaves the root is refused. A tool that takes a path from `input` should
   * resolve it the same way — see `resolveInside`.
   */
  declaredPaths(input: I, ctx?: ToolContext): string[];

  /**
   * The input `execute` reads, field by field. The in-process loop advertises it in the tool
   * catalog, and `executeToolGated` answers a call that does not match it with a failed result,
   * before `declaredPaths` and before policy, so nothing runs. Without it the model was told a
   * tool's id and description and left to guess its field names: it sent `patch.apply` a
   * `{path, patch}`, the tool read an undefined `diff`, and the node failed on a TypeError.
   *
   * Optional so that a tool written against an earlier version still compiles; a tool without
   * one is advertised without its input and its calls are not checked. Every built-in tool has one.
   */
  inputSchema?: ToolInputSchema;
}

/** The value types a tool input field can have: JSON's, without `null`. */
export type ToolInputType = 'string' | 'number' | 'boolean' | 'array' | 'object';

/** What every element of an `array` field must be. */
export interface ToolInputItems {
  type:  Exclude<ToolInputType, 'array'>;
  enum?: ReadonlyArray<string | number>;
}

/** One field of a tool's input. `number` means a finite number. */
export interface ToolInputProperty {
  type:        ToolInputType;
  description: string;
  /** The only values the field takes. */
  enum?:       ReadonlyArray<string | number>;
  /** For an `array` field: what each element must be. */
  items?:      ToolInputItems;
}

/**
 * A tool's input as a small subset of JSON Schema: an object of named fields, each with one type.
 * Small on purpose — it is written by hand beside the code that reads the input, rendered into the
 * system prompt, and checked by `toolInputProblem`, and each of those has to agree on what it means.
 */
export interface ToolInputSchema {
  type:        'object';
  properties:  { readonly [name: string]: ToolInputProperty };
  required:    readonly string[];
  /** `false`: a field not in `properties` makes the input malformed. Every built-in tool says `false`. */
  additionalProperties?: boolean;
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
  /**
   * Accept this node as succeeded when its role stops on its own budget (`budget_exhausted`),
   * with the reason returned beside its output as a {@link PartialNodeOutcome}. Off unless a
   * node says so, because a node that did not finish did not succeed (D-04).
   */
  allowPartial?: boolean;
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

// WP-3.6 — additive: where a run's DAG came from. The bundle and the Run node record it, so an
// operator reading an attestation can tell a plan a model made from one a file asked for; without
// it the two runs differ only in a line of stdout that is not part of the signed record.
export type PlanSource =
  /** `--plan-from`: the DAG was read from this file, whose bytes hash to `sha256`. */
  | { kind: 'spec'; path: string; sha256: string }
  /** The planner was asked, and its answer is the plan. */
  | { kind: 'planner' };

/**
 * The largest delay a Node timer honours. Above it `setTimeout` fires after 1 ms instead, so a
 * timeout or a backoff that big would mean "at once". Both readers of a millisecond field — the
 * `.maf/config.yaml` loader and the `--plan-from` spec's `timeoutMs` — bound it by this one value,
 * so the two cannot disagree about what a valid timeout is (WP-3.6, R3).
 */
// WP-3.6: shared timer ceiling — the `.maf/config.yaml` loader and the `--plan-from` `timeoutMs` bound.
export const MAX_TIMER_MS = 2 ** 31 - 1;

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

/**
 * A window during which a writer node held the scheduler's writer lock (WP-3.0c, the F7 window).
 * The runner records one per writer turn; the dispatcher reads them to tell a reader's own change
 * from a concurrent writer's — the one case the reader's two working-tree snapshots cannot separate
 * on their own, because a sibling writer's uncommitted work in the shared tree lands inside the
 * reader's turn.
 */
export interface WriterLockInterval {
  nodeId: NodeId;
  /** The monotonic reading (`performance.now()`) when the writer acquired the lock. */
  from:   number;
  /** The monotonic reading when it released it. */
  to:     number;
}

/**
 * The scheduler's writer lock, as the two things that need it see it: the runner records the
 * intervals, and the dispatcher asks which writers overlapped a reader's turn, and whether one is
 * still holding. An interface rather than the runner itself, so the dispatcher need not know the
 * scheduler.
 *
 * Times are monotonic readings (`performance.now()`), never a wall clock. Only the order and the
 * overlap of holds are ever asked about, and `Date.now()` answers both badly: it steps backwards on
 * an NTP correction or a manual clock change, and its millisecond resolution returns the same value
 * for a release and the very next reader's start, which would excuse that reader for its own change.
 */
export interface WriterLockLedger {
  /** A writer acquired the lock. */
  enter(nodeId: NodeId): void;
  /** The writer released it. A no-op for a node that never entered. */
  exit(nodeId: NodeId): void;
  /**
   * Every writer whose hold overlapped any part of `[from, to]`, in acquisition order: the writers
   * that have released, oldest first — writers are serialized, so that order is the order they ran —
   * followed by any writer still holding. Empty when no writer overlapped. The caller drops its own
   * node, which on the cli tier holds the lock itself.
   */
  writersOverlapping(from: number, to: number): NodeId[];
  /** Whether `nodeId` holds the lock right now — entered, not yet exited. */
  isHolding(nodeId: NodeId): boolean;
}

export interface RetryPolicy {
  maxAttempts:   number;
  backoffMs:     number;
  backoffFactor: number;
  jitterMs:      number;
}

/**
 * Two attempts: one retry rides out a dropped connection or a stalled process, and every
 * further attempt re-runs an agent that may already have changed the tree (D-06). Every
 * place that mints a node's retry policy starts from this one value, so the default cannot
 * drift between the planner, the parser and the dispatcher.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:   2,
  backoffMs:     1000,
  backoffFactor: 2,
  jitterMs:      500,
};

/**
 * The channel failed, not the work: the backend timed out, exited non-zero without writing
 * anything, could not be started, or the network dropped. Nothing about the request was
 * judged, so asking again can succeed. This is the only kind of error a DAG node is retried
 * on (D-06); subclass it for a more specific transport failure.
 */
export class TransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/**
 * A judgement on the work: a gate refused it, or policy forbade it. Asking again puts the
 * same question to the same judge, and a refusal that a retry can overturn was never a
 * refusal — so a VerdictError is terminal and never retried (D-06). Gate and policy errors
 * subclass it.
 *
 * R8: a new subclass here needs its own kind in `outcomeFailureKind` (below). The classifier keys the
 * policy case on this base class — because the two `PolicyViolationError` classes both subclass it and
 * this package cannot name either — so a subclass that is neither a `GateRefused` nor a `ReviewRefused`
 * would otherwise be reported in a run's outcome as `'policy_violation'`.
 */
export class VerdictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VerdictError';
  }
}

/**
 * A path a tool refuses whatever the policy says: confinement built into the tool, not a rule. The
 * one case today is git's own data — `fs.write`, `fs.delete` and `patch.apply` refuse a path into
 * `.git`, because the worktree's `.git` is what keeps every git tool on the run's branch. Thrown from
 * `declaredPaths` (the spelling) and from `execute` (the resolved path); the gate turns it into an
 * attested `Deny`, so the model is told why and the node goes on.
 */
export class PathConfinementError extends Error {
  /**
   * @param path   the path as the caller named it
   * @param reason why it is refused, as a clause ("the path names git's own data (.git)")
   */
  constructor(message: string, readonly path: string, readonly reason: string) {
    super(message);
    this.name = 'PathConfinementError';
  }
}

/**
 * A tool cannot say which paths it will touch, so no path rule can cover it. Thrown from
 * `declaredPaths` — `patch.apply` on a diff whose headers name no file, or name one only in a form
 * it does not read — and turned by the gate into an attested refusal (`builtin:declaration`) that
 * the model is handed, so nothing runs. Fail-closed: an undeclarable call is not an unjudged one.
 */
export class ToolDeclarationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolDeclarationError';
  }
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
  /**
   * The node's failure as a value (L3): the kind, and — for a refusal — the rule and tool. Present for
   * a node that failed with any verdict — a `NodeFailure`, a `GateRefused`/`ReviewRefused` or a
   * `PolicyViolationError` — so a machine check reads the verdict directly rather than grepping
   * `error`. Absent means MAF did not classify the failure — a transport failure or a programming
   * error, never a verdict. A `0.3.x` outcome carries none and still parses.
   */
  failure?:    OutcomeFailureDetail;
  agentId?:    AgentId;
}

/**
 * Why a node that ran did not finish its work.
 *
 *  - `adapter_failed`   — CLI tier: the adapter reported `success: false` (a timeout's exit 124,
 *                         an expired login, an HTTP error body).
 *  - `empty_output`     — CLI tier: a role holding a write tool returned no output.
 *  - `no_change`        — a role that expects to change the tree (`expectsChange`) answered on
 *                         either tier, but its diff against the node's start commit is empty —
 *                         what a backend that refused the edit under its own permission settings
 *                         looks like (D-32).
 *  - `no_work`          — in-process: a role that does not expect a change (`expectsChange` is not
 *                         `true`) — the built-in readers and the `tester` — that expects a tool
 *                         call (`expectsToolCalls`) finished with a final answer having made
 *                         **no executed tool call** — the attested calls whose result was not
 *                         `refused`, which is to say the calls that actually ran, an approved
 *                         `Escalate` among them (D-46, F4/A2). A role that called nothing has not
 *                         done its job: live row 2b's analyst answered "I could not" after the host's
 *                         native tools were refused, and the old reading called it `Succeeded` off
 *                         the prose. The mirror of `no_change` for a role judged by its calls, where
 *                         `no_change` is the one judged by the tree. The count is the node's *current
 *                         attempt*, so a retry that read only on an earlier attempt does not excuse it
 *                         (F3/A4).
 *  - `unexpected_change`— a role that holds **no** write tool changed the tree anyway (F7). On
 *                         the cli tier that is what a backend with file tools of its own does
 *                         whatever the role's allowlist says; MAF never sees those calls. The
 *                         exact mirror of `no_change`, and the reason a reader's turn is diffed.
 *  - `budget_exhausted` — in-process: the role's own `maxToolIterations` or `tokenBudget` ran
 *                         out, or a processor stopped the loop before a step.
 *  - `loop_failed`      — in-process: the loop itself reported failure.
 */
export type NodeFailureReason =
  | 'adapter_failed'
  | 'empty_output'
  | 'no_change'
  | 'no_work'
  | 'unexpected_change'
  | 'budget_exhausted'
  | 'loop_failed';

/**
 * Every kind of verdict a failed node can carry in the outcome (L3/A1): the `NodeFailureReason`s, plus
 * the three refusals the tree raises as `VerdictError`s rather than `NodeFailure`s — a security gate
 * (`GateRefused`), a human review (`ReviewRefused`) and a policy refusal (`PolicyViolationError`). The
 * point of the field is a machine-readable verdict, and a gate refusal is the most important verdict
 * there is, so it gets a kind of its own rather than being left unclassified.
 */
export type OutcomeFailureKind =
  | NodeFailureReason
  | 'gate_refused'
  | 'review_refused'
  | 'policy_violation';

/**
 * The machine-checkable half of a node failure (L3): the `kind`, and — when a policy refusal caused
 * it — the rule and the tool that refused, taken from the first refused call the F10 clause named.
 * Carried on the run outcome beside the failure's prose, so a machine check reads the verdict rather
 * than grepping the message. A `no_change` caused by anything other than a refusal (a backend that
 * simply changed nothing) names neither, as does a gate or a review refusal — those carry no rule or
 * tool of their own.
 */
export interface OutcomeFailureDetail {
  kind:    OutcomeFailureKind;
  ruleId?: string;
  toolId?:  string;
}

/**
 * The kind for a node's error, or `undefined` when there is none (L3/A1). Present for any *verdict* —
 * a `NodeFailure`, a gate or review refusal, a policy refusal — so the outcome says why a node failed
 * for every failure that was a judgement. Absent for a transport failure (the backend timed out or
 * never started) and for a programming error: neither is a verdict, and inventing a kind for one would
 * have the outcome assert something the run does not know.
 *
 * Order matters. `ReviewRefused` extends `GateRefused`, so it is tested first; and the policy refusal
 * is tested as its base `VerdictError`, because the two `PolicyViolationError` classes in the tree
 * (policy-engine's `PolicyEngine` and `ViolationHandler`) both subclass it and `@maf/types` cannot
 * depend on `@maf/policy-engine` to name either. `VerdictError` is documented as "a gate refused it,
 * or policy forbade it", and the gate cases are already taken above, so what is left is a policy
 * refusal.
 */
export function outcomeFailureKind(err: unknown): OutcomeFailureKind | undefined {
  if (err instanceof NodeFailure) return err.reason;
  if (err instanceof ReviewRefused) return 'review_refused';
  if (err instanceof GateRefused) return 'gate_refused';
  if (err instanceof VerdictError) return 'policy_violation';
  return undefined;
}

/**
 * The failure as a value for the run outcome (L3/A11): the kind the dispatcher decided, and — where a
 * refusal named them — the rule and the tool. A plain `Error` is a transport or programming failure with
 * no verdict to report, and inventing one would have `failure` assert something the run does not know;
 * there the field is left absent. Keys with no value are left out, so a `no_work` with no refusal reads as
 * exactly `{ kind: 'no_work' }` rather than a record salted with `undefined`.
 *
 * A `NodeFailure` names its rule and tool as its own fields; a policy refusal names them on its
 * `decision`, read structurally for the reason `outcomeFailureKind` gives — the two
 * `PolicyViolationError` classes both subclass `VerdictError` and neither is importable here. The read
 * mirrors the F10 clause in the dispatcher (`refusingRuleId`): a `Deny` or `Indeterminate` names the rule
 * on the decision, an `Escalate` on the request the gate was shown. A gate or review refusal names
 * neither — those carry no rule or tool of their own.
 */
export function outcomeFailureDetail(err: unknown): OutcomeFailureDetail | undefined {
  const kind = outcomeFailureKind(err);
  if (kind === undefined) return undefined;
  return { kind, ...namedRefusal(err) };
}

/** The shape a `PolicyViolationError.decision` is read by; a superset of every `PolicyDecision` member. */
interface RefusalShape {
  verdict:          string;
  ruleId?:          unknown;
  toolId?:          unknown;
  approvalRequest?: { policyRuleId?: unknown };
}

/**
 * The rule and tool an error names, read off it (A11). A `NodeFailure`'s own fields first; failing that,
 * the `decision` a `PolicyViolationError` carries. `toolId` is read defensively — no `PolicyDecision`
 * carries one today, so a bare refusal recovers only its rule; the tool reaches the outcome through the
 * dispatcher's F10 `NodeFailure`, which knows the refused call.
 */
function namedRefusal(err: unknown): { ruleId?: string; toolId?: string } {
  if (err instanceof NodeFailure) {
    return {
      ...(err.ruleId !== undefined ? { ruleId: err.ruleId } : {}),
      ...(err.toolId !== undefined ? { toolId: err.toolId } : {}),
    };
  }
  const decision = refusalDecision(err);
  if (decision === undefined) return {};
  const ruleId = ruleIdOf(decision);
  const toolId = typeof decision.toolId === 'string' ? decision.toolId : undefined;
  return {
    ...(ruleId !== undefined ? { ruleId } : {}),
    ...(toolId !== undefined ? { toolId } : {}),
  };
}

/** The decision a policy refusal carries, duck-typed: a refusal is an object that names a verdict. */
function refusalDecision(err: unknown): RefusalShape | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const decision = (err as { decision?: unknown }).decision;
  if (decision === null || typeof decision !== 'object') return undefined;
  return typeof (decision as { verdict?: unknown }).verdict === 'string'
    ? (decision as RefusalShape)
    : undefined;
}

/** The rule a refusal names — the same switch the engine and the dispatcher make (`refusingRuleId`). */
function ruleIdOf(decision: RefusalShape): string | undefined {
  switch (decision.verdict) {
    case 'Deny':
    case 'Indeterminate': return typeof decision.ruleId === 'string' ? decision.ruleId : undefined;
    case 'Escalate':      return typeof decision.approvalRequest?.policyRuleId === 'string'
      ? decision.approvalRequest.policyRuleId
      : undefined;
    default:              return undefined;
  }
}

/**
 * A node that ran but did not finish (D-04). Before this existed, a failed adapter call and an
 * exhausted budget both came back as ordinary output, and the scheduler recorded the node as
 * succeeded. The `reason` is a field rather than a phrase in the message so that whoever
 * decides what happens next — retry, fail the run, accept partial work — branches on a value.
 */
export class NodeFailure extends Error {
  readonly reason:   NodeFailureReason;
  /** The adapter's exit code, when the failure came from a CLI-tier invocation. */
  readonly exitCode: number | undefined;
  /** The policy rule that refused the call this failure is about, when one did (L3). */
  readonly ruleId:   string | undefined;
  /** The tool the refused call named, when the failure is about a refusal (L3). */
  readonly toolId:   string | undefined;

  constructor(
    reason: NodeFailureReason,
    message: string,
    exitCode?: number,
    detail?: { ruleId?: string; toolId?: string },
  ) {
    super(message);
    this.name = 'NodeFailure';
    this.reason = reason;
    this.exitCode = exitCode;
    this.ruleId = detail?.ruleId;
    this.toolId = detail?.toolId;
  }
}

/**
 * What a node that opted in to `allowPartial` returns beside its output, under the `outcome`
 * key, when it stopped early: the node still succeeds, and this is how a run summary can say
 * the work was partial rather than finished.
 */
export interface PartialNodeOutcome {
  status: 'partial';
  reason: NodeFailureReason;
  detail: string;
}

/**
 * What the scheduler knows about a node once it has judged it failed (D-16): enough for the
 * planner to recognise the task next time. Plain values, so a recorder needs nothing from the
 * scheduler and the scheduler nothing from the graph.
 */
export interface NodeFailureRecord {
  runId:     RunId;
  nodeId:    NodeId;
  /** The node's own short label. */
  label:     string;
  /** What the node was asked to do: its `metadata.taskDescription`, or its label without one. */
  task:      string;
  /**
   * The title of the run the node was planned for (its `metadata.runTitle`), when the planner set
   * one. A planned node's instruction is its own step, so the run's title is what the next plan
   * for the same task can recognise.
   */
  runTitle?: string;
  role:      RoleName;
  /** `NodeFailure.reason` when the error was one; otherwise the error's class name (a plain `Error`'s `name`). */
  reason:    string;
  message:   string;
  /** `NodeFailure.exitCode`, when the failure came from a CLI-tier invocation. */
  exitCode?: number;
}

/**
 * Where a failed node is written down so the planner can recall it (D-16). The scheduler calls
 * it once per node, after the node's retries are spent; the memory graph implements it.
 */
export interface FailureRecorder {
  recordFailure(input: NodeFailureRecord): Promise<void>;
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
  // WP-3.8 follow-up: resolves only after the backend has released the graph's files, so a
  // caller that removes or reopens them does so after awaiting it rather than racing the release.
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLICY ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { verdict: 'Allow' }
  | { verdict: 'Deny';     reason: string; alternative?: ToolId; ruleId?: string }
  | { verdict: 'Escalate'; reason: string; approvalRequest: ApprovalRequest }
  /**
   * The policy could not be evaluated, so no verdict about the call is available — and the call
   * does not proceed. The policy engine answers it when a rule's `memoryPattern` query failed, so a
   * `Deny` rule that might have matched did not get to say so. Answering `Allow` there is the
   * fail-open D-08 names, and it is the easiest state for an attacker to induce (break the
   * graph, then act). Distinct from `Escalate`: nothing is being asked of a human, because
   * there is no decision to approve.
   *
   * `executeToolGated` also records it, under rule id `builtin:input-schema`, for a call whose
   * input does not match the tool's `inputSchema`: the policy was never asked, because there was
   * no call it could judge. That call is answered to the model as a failed result, not thrown.
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
   *
   * The paths are interpreted relative to `ctx.projectRoot` and are resolved with
   * `resolveInside` before any rule is consulted. Two consequences a caller can rely on:
   * a rule's globs are matched against the *real* file (so every spelling of one path is one
   * string), and a declared path that resolves outside `ctx.projectRoot` is **refused** with a
   * `Deny` — before the rule list is read, and whether or not any rule is loaded. Confinement
   * is therefore not something a policy file can turn off by being empty.
   */
  evaluate(
    toolId: ToolId,
    input: ToolInput,
    ctx: ToolContext,
    declaredPaths: readonly string[],
  ): Promise<PolicyDecision>;

  /**
   * The rules that governed this engine and how its calls fell, for the run's bundle (F6). Optional
   * because a handle that is a test double need not answer it; a production engine always does.
   *
   * Without it a reader cannot tell "no policy was loaded" from "a Deny rule was loaded and never
   * consulted": for a run whose `toolCalls` and `securityFindings` are both empty those two runs
   * produce byte-identical policy evidence. The counts are read after the run, so they cover every
   * call until then — including a refusal, which is attested but reaches no tool.
   */
  inForce?(): PolicyInForce;
}

/** A rule as the bundle records it: what it was called, what it would do, and what it matches. */
export interface PolicyRuleSummary {
  id:      string;
  effect:  PolicyAction['kind'];
  /** The predicate in one line, so a reader sees a rule's reach without the whole file. */
  matcher: string;
}

/** How the run's calls were decided. `indeterminate` is a refusal the policy could not make. */
export interface PolicyVerdictCounts {
  allow:         number;
  deny:          number;
  escalate:      number;
  indeterminate: number;
}

/** How the rules in force were chosen (D-49). */
export type PolicySourceKind = 'file' | 'built-in' | 'none';

/**
 * The policy in force for a run (F6, D-49): the file when there was one, which of the three sources
 * chose the rules, the digest of the bytes in force, the rules, and the counts.
 *
 * `source` keeps the meaning it had in 0.4.0 — the policy file's resolved path, absent when no user
 * file supplied the rules — and `sourceKind` is the additive field that says which of the three
 * sources chose them (F5). A 0.4.0 reader therefore sees the path it has always seen, or no path
 * when there was none; it never reads a kind where it expects a path.
 *
 * `sha256` is absent exactly when there were no bytes to digest. A `file` source therefore keeps its
 * 0.4.0 reading — absent means a path was named but no file was read — distinct from a file that was
 * read and held zero rules. The built-in source carries the shipped asset's digest (F9(d)), so a
 * reader can tell which text actually applied.
 */
export interface PolicyInForce {
  /** The run's resolved policy file path. Absent for the built-in policy and for `none`. */
  source?: string;
  /** How the rules were chosen: a policy file, the shipped built-in policy, or no policy at all. */
  sourceKind?: PolicySourceKind;
  /** sha256 of the bytes in force: the file's, or the shipped asset's for the built-in policy. */
  sha256?: string;
  ruleCount: number;
  rules:    PolicyRuleSummary[];
  counts:   PolicyVerdictCounts;
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

/**
 * The call an `Escalate` verdict is about, as `executeToolGated` holds it: the input the tool will
 * run on and the paths it declared. The gate binds its decision to these, not to the request's
 * description, which is prose.
 */
export interface ApprovalAsk {
  request:       ApprovalRequest;
  toolId:        ToolId;
  input:         ToolInput;
  declaredPaths: readonly string[];
}

export interface ApprovalOutcome {
  /** Only `true` runs the call; it is good for the one call it was asked about. */
  approved:    boolean;
  status:      ApprovalStatus;
  requestId:   string;
  /** sha256 of the canonical request; empty when the request could not be hashed (and was refused). */
  requestHash: string;
  reason:      string;
}

/**
 * Asked by `executeToolGated` on an `Escalate` verdict. Lives here rather than in
 * `@maf/approval-gate` so `@maf/tool-loop` needs no dependency on the gate's implementation.
 * `decide` settles every request it is given and records the decision in the attestation; it does
 * not throw for a refusal.
 */
export interface ApprovalGateHandle {
  decide(ask: ApprovalAsk): Promise<ApprovalOutcome>;
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

/**
 * The tier a node actually ran on (F7). MAF's policy engine, processors and attestor see an
 * individual tool call only on the in-process tier; on the cli tier the backend runs its own
 * tools and MAF sees one opaque result. So a policy rule scoped to a role that ran cli-tier was
 * unreachable — it is in force, it never fired, and `policyInForce` alone cannot show that.
 * Beside it the bundle names the tier whose rule it was, and the reader settles it.
 *
 * One entry per node, last write winning: a retry resolves the same tier (it is a function of the
 * role and the adapter), so a retried node reads as one node with one tier.
 */
export interface ExecutionTierRecord {
  nodeId:  string;
  role:    string;
  tier:    'cli' | 'in-process';
  /** The adapter that ran the node — `fellBackFrom` is only meaningful beside it. */
  adapter: string;
  /**
   * Set when the role asked for `in-process` but the adapter could not run the loop, so it ran
   * cli-tier instead. Present, the reader can see that a governed turn was intended and not
   * performed; absent, the node ran on the tier its role asked for.
   */
  fellBackFrom?: 'in-process';
}

/**
 * The security gate refused a writer node's change: blocking findings, an unreadable review,
 * or a diff over the gate's size cap (then `findings` is empty, because nothing was reviewed).
 *
 * A class rather than a message, because the scheduler has to tell a verdict from a transport
 * failure: retrying a refused node would diff a tree the first attempt may already have
 * committed, and an empty diff passes (D-06).
 */
export class GateRefused extends VerdictError {
  constructor(message: string, readonly findings: SecurityFinding[]) {
    super(message);
    this.name = 'GateRefused';
  }
}

/**
 * A required human review did not approve a writer node's change: the reviewer denied it, did not
 * answer in time, failed before deciding or answered with something that is not a decision — or
 * the run's harness requires review and no required review gate was wired to ask anyone.
 *
 * A GateRefused, so whatever already treats a gate's refusal as final treats this one the same: it
 * is never retried (D-06), and a dispatcher that meets it on the way out of a failing backend does
 * not review the diff a second time. `findings` is empty; a human review produces none.
 */
export class ReviewRefused extends GateRefused {
  /** The review request this refusal answers; undefined when no reviewer was asked. */
  readonly requestId: string | undefined;

  constructor(message: string, requestId?: string) {
    super(message, []);
    this.name = 'ReviewRefused';
    this.requestId = requestId;
  }
}

export interface GoldensSection {
  harnessSha:      string;
  harnessId:       string;
  solvedTaskIds:   string[];
  total:           number;
  ranAt:           string;
}

/**
 * Which key signed a bundle. `'dev'` is the public development key: anyone can produce a bundle
 * that verifies under it, so such a bundle is no evidence of who ran what.
 */
export type KeySource = 'env' | 'dev';

export interface AttestationBundle {
  runId:             RunId;
  /** Part of the signed payload, so it cannot be stripped or flipped without breaking the signature. */
  keySource:         KeySource;
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
  /**
   * The policy rules that governed the run and how its calls fell (F6). Optional so a 0.3.0 and
   * earlier bundle still parses; a reader must treat its absence as "unrecorded", never as "none".
   */
  policyInForce?:    PolicyInForce;
  /**
   * What each role call showed the model (F4), in order. Absent when no call reported one. Both
   * tiers since WP-3.0c (D-45) — a governed turn and a cli-tier `invoke` alike — so "absent" is
   * "unrecorded", never "nothing ran on the cli tier".
   */
  modelSurfaces?:    ModelSurfaceRecord[];
  /**
   * The tier each node ran on (F7), in dispatch order. Absent when no node reported one — a
   * reader must treat that as "unrecorded", never as "every node ran governed".
   */
  executionTiers?:   ExecutionTierRecord[];
  /**
   * Changes a reader's turn attributed to a concurrent writer (WP-3.0c, the F7 window), in the
   * order they were seen. Absent when none were — a reader must treat that as "none attributed",
   * which is the same as "none happened".
   */
  attributedChanges?: AttributedChange[];
  /** Golden-suite outcome for the harness under test (eval-harness runs only). */
  goldens?:          GoldensSection;
  signature:         string;
  bundledAt:         Date;
}

export interface AttestorHandle {
  record(call: Omit<ToolCallRecord, 'id'>): Promise<void>;
  /**
   * Attach one role call's model-facing surface to the bundle (F4; both tiers since WP-3.0c, D-45).
   * Optional so a test double that records only tool calls still satisfies the handle.
   */
  recordModelSurface?(record: ModelSurfaceRecord): void;
  /** Attach the policy in force (F6); the last call wins, as it runs once per run. */
  recordPolicyInForce?(policy: PolicyInForce): void;
  /** Attach the tier a node ran on (F7); one per node, a retry replacing the node's own entry. */
  recordExecutionTier?(record: ExecutionTierRecord): void;
  /**
   * Attach one change a reader's turn attributed to a concurrent writer (WP-3.0c, the F7 window).
   * Optional so a test double that records only tool calls still satisfies the handle.
   */
  recordAttribution?(record: AttributedChange): void;
  /**
   * The tool calls recorded for one task (F10). A node's `no_change` failure names the policy
   * rules that denied that node's *own* calls, so the reader is told which rule stopped the write
   * rather than only that nothing changed — the run-wide counts answer a different question.
   * Optional so a test double that records only tool calls still satisfies the handle; absent,
   * the message carries no deny note.
   */
  toolCallsForTask?(taskId: TaskId): ToolCallRecord[];
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
  /**
   * Whether the backend may use tools of its own — a CLI's file, shell and edit tools.
   *
   *  - `true` (default) — a cli-tier turn where the backend is meant to act with its own tools.
   *  - `false`          — the call needs only text (a plan, a review verdict), and whatever a tool
   *                       did would happen outside MAF's gates — after the security review, for the
   *                       reviewer.
   *  - `'read-only'`    — a role that holds no write tool. The backend keeps the tools it needs to
   *                       read (F7) and loses the ones that could change the tree, so a change MAF
   *                       would otherwise have to catch after the fact cannot be made at all.
   *
   * An adapter that knows no flag for `false` or `'read-only'` says so where it builds its argv, and
   * ignores the value: the run's unexpected-change guard is then the only thing standing between a
   * "read-only" role and an edited tree.
   */
  nativeTools?:     boolean | 'read-only';
}

export interface AdapterInvokeResult {
  success:     boolean;
  output:      string;
  tokensUsed?: number;
  toolCallLog: ToolCallRecord[];
  exitCode:    number;
  duration:    number;
  /**
   * Set when the backend gave no answer for a reason that says nothing about the request —
   * a timeout, a silent non-zero exit, a process that could not start. The dispatcher turns it
   * into a retryable failure (D-06); without it, `success: false` is a judgement and is not
   * retried.
   */
  transportError?: TransportError;
  /**
   * The model-facing surface of this cli-tier call (WP-3.0c): what MAF showed the backend and what
   * it answered, so a role call is in the record wherever it ran. Absent when the adapter assembles
   * none — an HTTP backend has no argv of its own to report.
   */
  modelSurface?: ModelSurface;
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
  /**
   * What MAF showed the model this turn (F4). The adapter that assembles the system block reports
   * it, because that is where the exact bytes and the backend argv exist; the loop records it. An
   * adapter that assembles no surface of its own omits it.
   */
  modelSurface?: ModelSurface;
}

/**
 * What one turn showed the model: the system block's digest, the tool catalogue as sent, and the
 * backend argv. It exists because a model's claim about its own tools — `fix-test`'s "only one tool
 * is actually registered: `LSP`" — cannot be adjudicated from a transcript that holds neither the
 * prompt nor the argv, and the two mechanisms that could produce the claim (the model reasoning from
 * an empty *native* tool list; something per-run exposing a plugin tool) are indistinguishable
 * without this. Since WP-3.0c both tiers record one: a governed turn from the loop, a cli-tier call
 * from the adapter.
 */
export interface ModelSurface {
  /** sha256, hex, of the exact system-prompt bytes handed to the backend this turn. */
  systemPromptSha256: string;
  /**
   * The serialized tool catalogue exactly as the system block carried it — MAF's own registry, the
   * tools a governed turn runs through the policy gate. On a `tier: 'cli'` record this is always `''`,
   * and `''` there means "MAF composed no catalogue", **not** "the model was offered no tools": MAF
   * sends a cli-tier backend one opaque prompt and no catalogue at all, and what that backend then
   * has is its own — see `argv` for the flags it was given and `ModelSurfaceRecord.nativeTools` for
   * what the dispatcher asked of them.
   */
  toolCatalog:        string;
  /**
   * sha256, hex, of the prompt this call sent (WP-3.0c). A cli-tier role call hands the backend one
   * opaque prompt and there was no record of it; this is that digest. Absent on a governed turn,
   * whose prompt is the serialized history the loop owns rather than a single string.
   */
  promptSha256?:      string;
  /**
   * sha256, hex, of what a backend that reads its prompt on stdin was actually written (WP-3.0c).
   * Codex joins the system block and the prompt into one blob on the stream, so `systemPromptSha256`
   * and `promptSha256` — the two parts — do not by themselves say what was sent; this is that blob.
   * Absent when the backend takes its prompt on the command line, where `argv` shows it.
   */
  stdinSha256?:       string;
  /**
   * sha256, hex, of the output the backend returned (WP-3.0c). Absent on a governed turn, whose
   * answer is a parsed `AssistantTurn`, not one stdout string.
   */
  outputSha256?:      string;
  /**
   * L1: the model the call named, when it named one. The planner and the security gate are calls
   * MAF makes directly rather than through a role's dispatcher, so neither carries a node's
   * `modelOverride`; without this a reader of the surface could not tell which model was asked for.
   * Absent when the call asked for the adapter's own default.
   */
  model?:             string;
  /**
   * The backend argv. Payload positionals — the system-prompt value and the trailing prompt — are
   * replaced by `<name: N bytes, sha256 H>` markers, so the *flags* (including the empty string that
   * is `--tools ""`) are readable without the record carrying the whole prompt.
   */
  argv:               string[];
}

/** One turn's surface, as the bundle records it: which node and turn it was, and what was sent. */
export interface ModelSurfaceRecord extends ModelSurface {
  role:   string;
  taskId: TaskId;
  /**
   * 1-based loop step within the node. A step whose model call was malformed and retried records one
   * entry per attempt, all sharing this number; the array is in call order, so a repeated `turn` reads
   * as a retry, not a duplicate.
   */
  turn:   number;
  /**
   * Which tier produced this surface (WP-3.0c, D-45): the governed loop's turn ('in-process') or a
   * cli-tier `invoke` ('cli'). Optional so a 0.3.1 bundle — whose records carry no tier — still
   * parses; a reader must treat its absence as "unrecorded", never as a tier.
   */
  tier?:  'cli' | 'in-process';
  /**
   * What the dispatcher asked of the backend's own tools on this cli-tier call: `'full'` (nothing was
   * asked — the default, and the backend keeps its native tools), `'read-only'` (a role holding no
   * write tool), or `'none'` (a call that needs only text). Recorded because for codex and gemini
   * nothing in `argv` shows it: neither CLI has a flag that withholds its built-in tools, so both
   * keep everything whatever was asked. It is what was *asked for*, not what the backend did with it.
   */
  nativeTools?: 'full' | 'read-only' | 'none';
  // L1: which of MAF's own model calls this record is, when it is not a role's turn. Absent reads
  // as a role call, so a bundle written before this field parses unchanged. The planner is the
  // run's call (no node), and the security gate's call names the node whose diff it reviewed in
  // `taskId`, so both land in the one array rather than in a second record.
  kind?: 'planner' | 'security-gate';
}

/**
 * A change a reader's turn saw that was a concurrent writer's (WP-3.0c, the F7 window). The reader's
 * two working-tree snapshots cancel out uncommitted work already in the tree when it began, but a
 * sibling writer that ran *during* the reader's turn lands inside its bracket. When the lock ledger
 * shows a writer took the change to a gate, the change is recorded here instead of failing the node:
 * either that writer still holds the lock, so its own start-commit diff will carry the change to its
 * gate, or its gate has run and its reviewed diff already holds every path in this reader's bracket.
 * The bracket diff is recorded beside it, as the subject `<node>.attributed.diff`, so `diffSha256`
 * names a diff the statement carries a digest for — in `diffHashes`, like every subject — rather than
 * naming a change written down nowhere.
 *
 * The three tree ids below are what make that digest checkable rather than merely present (N6): the
 * recorded `diffSha256` is `sha256` of `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git diff
 * --text --no-ext-diff --no-textconv --no-renames <fromTree> <toTree>` in the run's repository — the
 * flags the digest was taken with, so a verifier recomputes it in the same shape rather than with a
 * plain `git diff`, which differs for binary content and for a host git config. The two trees are
 * unreachable objects, so recompute soon: `git gc` may prune them after `gc.pruneExpire` (two weeks
 * by default). `writerGateTree` names the content the named writer's gate read, and is absent when
 * the change was attributed on the lock alone (rule (a)) — a writer whose gate had not yet run has no
 * gate tree to name.
 */
export interface AttributedChange {
  nodeId:       string;
  /** The writer whose reviewed diff carries the change, or that is still holding the lock over it. */
  attributedTo: string;
  /** sha256, hex, of the bracket diff the reader's turn showed; the content of `<node>.attributed.diff`. */
  diffSha256:   string;
  /** The reader's bracket start tree id; with `toTree`, the pair `diffSha256` is reproducible from (flags in the note above). */
  fromTree:     string;
  /** The reader's bracket end tree id. */
  toTree:       string;
  /** The tree the named writer's gate read; absent when the writer was named on the lock alone (rule (a)). */
  writerGateTree?: string;
}

/**
 * TurnAdapter — implemented by adapters that can drive a multi-turn conversation
 * with explicit tool-call round-tripping, letting MAF's policy engine and
 * processor pipeline intercept EVERY tool call (the legacy CliAdapter.invoke
 * path dispatches one opaque invocation where tools are advisory).
 *
 * See README.md, "In-process execution & the tool-call protocol".
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

// ─────────────────────────────────────────────────────────────────────────────
// PATHS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Path confinement lives here, beside `ToolContext`, for the same reason `PolicyEngineHandle`
 * does: both the tools and the policy engine need it, and the tools must not depend on the
 * policy engine (or the reverse) to get it. `scripts/check-workspace-deps.mjs` holds the
 * package graph acyclic, so a shared primitive between two packages goes in the package they
 * both already depend on — this one.
 *
 * `paths.ts` imports `node:fs`, so this package is no longer types-only: it holds runtime code
 * that touches the filesystem. That is a deliberate choice, not drift. The alternative was to
 * put the check in `@maf/tools` (the policy engine would then depend on the tools, which is
 * backwards) or in `@maf/policy-engine` (the tools would depend on it, inverting the layering
 * the same way). Both consumers already depend on this package, so the primitive costs no new
 * edge and no cycle; the price is one runtime module here, and it is accepted.
 */
export { resolveInside, PathEscapeError } from './paths.js';
export type { ConfinedPath } from './paths.js';

/**
 * Canonical JSON lives here for the reason path confinement does: the harness sha and the
 * attestation signature (D-13) both need the one serializer, and both packages already depend
 * on this one, where an `attestation → harness-config` edge would be a new dependency.
 */
export { canonicalJson } from './canonicalJson.js';

/**
 * A tool's input schema rendered and checked here, where both readers already depend: the turn
 * protocol (`@maf/adapter-base`) writes the catalog with `describeToolInput`, and the gate
 * (`@maf/tool-loop`) and the tools themselves check a call with `toolInputProblem`. One renderer,
 * so the error a malformed call gets quotes the input exactly as the catalog advertised it.
 */
export { describeToolInput, toolInputProblem, toolFailureMessage } from './toolInput.js';
export type { ToolInputCheckOptions } from './toolInput.js';

// The secret scrubber lives here, in the package every other @maf package already depends on,
// rather than in `@maf/processors` where it grew up. Two of its callers — the security gate
// (`@maf/git-ops`, which the workspace-deps guard keeps a leaf on `@maf/types` alone) and the
// tool protocol (`@maf/adapter-base`) — must mask model text before it reaches a record, and
// neither may take a new edge to do it. One home, reached without a new dependency; the
// processors package re-exports these names so no existing importer moves.
export {
  CREDENTIAL_PATTERNS, ASSIGNMENT_PATTERNS, DEFAULT_PATTERNS,
  redactCredentials, redactSecrets, redactText,
  redactCredentialsRecord, redactRecord,
} from './redaction.js';

/**
 * The environment for a child that runs project code. In 0.5.1 that child is `patch.apply`'s
 * `git apply`: the allowlist keeps `GIT_DIR`/`GIT_CONFIG_*`, every provider token and every
 * `MAF_*` variable in maf's own environment out of a process a patch an agent wrote controls.
 */
export { toolEnv } from './childEnv.js';

/**
 * L1: the surface of a model call an adapter did not describe. The planner (`@maf/cli`) and the
 * security gate (`@maf/git-ops`) both call `adapter.invoke` directly, and the gate's package is a
 * leaf on this one by design — so the helper lives here, where both already reach, rather than
 * giving either a new edge to an adapter package that builds the other kind of surface.
 */
export { callModelSurface, sha256Hex } from './surface.js';
