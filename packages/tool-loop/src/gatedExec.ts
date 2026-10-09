import type {
  ToolPlugin, ToolInput, ToolResult, ToolContext,
  PolicyEngineHandle, AttestorHandle, PolicyDecision, ApprovalAsk, ApprovalGateHandle, ApprovalOutcome,
} from '@maf/types';
import { PathConfinementError } from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { redactSecrets, redactCredentialsRecord } from '@maf/processors';

export interface GatedExecDeps {
  policy:   PolicyEngineHandle;
  attestor: AttestorHandle;
  /**
   * Asked when the policy answers `Escalate` (D-02). Absent, `Escalate` is refused as `Deny` is.
   * `| undefined` so a caller can pass an optional gate through as it is.
   */
  approvalGate?: ApprovalGateHandle | undefined;
}

/**
 * executeToolGated — the single gated execution path shared by ToolLoop and
 * InProcessAgentLoop: no behavior duplication between them (README.md,
 * "In-process execution & the tool-call protocol").
 *
 * Order is load-bearing: policy FIRST — anything but Allow (or an Escalate the
 * approval gate approves) is attested as a refusal and then thrown as
 * PolicyViolationError, and nothing executes — then tool.execute, then
 * attestation. A tool's built-in confinement (`PathConfinementError`, from
 * `declaredPaths` or from `execute` before it acts) is refused the same way, as a
 * `Deny` under rule id `builtin:git-dir`. Processor-mediated input edits happen upstream of this function —
 * policy always sees the final input.
 *
 * Secret redaction (L1): policy evaluation and execution use the REAL input, but
 * the values persisted (attestation bundle on disk + memory graph) and the result
 * returned into history have genuine CREDENTIAL FORMATS (API/LLM/cloud keys,
 * tokens, private keys) stripped. Only matched secret substrings are replaced, so
 * the signed attestation stays BYTE-FAITHFUL to the raw tool output except for the
 * secrets themselves — it is evidence. Broader assignment heuristics are applied
 * only to the model-facing history by SecretRedactProcessor, never here. This is
 * the single redaction point that also covers the ToolLoop path (no pipeline).
 */
export async function executeToolGated(
  tool: ToolPlugin,
  input: ToolInput,
  ctx: ToolContext,
  deps: GatedExecDeps,
): Promise<ToolResult> {
  // Frozen so the input the policy read is the input the tool runs on. A tool that rewrote
  // its own input inside `execute` decided its own paths after the gate had closed — writing
  // to a frozen input now throws instead, and throws loudly.
  deepFreeze(input);

  // The tool's own declaration, computed before any rule is consulted. An error here (a tool
  // that does not declare, a declaration that throws) propagates: failing to evaluate policy
  // is not permission to skip it. The one exception is the tool's built-in confinement refusing
  // a path, which is a verdict, not a failure: it is refused on the record like a `Deny`.
  let declaredPaths: string[];
  try {
    declaredPaths = tool.declaredPaths(input);
  } catch (err: unknown) {
    if (err instanceof PathConfinementError) return refuse(confinementDeny(err), undefined, tool, input, ctx, deps, new Date(), Date.now());
    throw err;
  }

  const policyDecision = await deps.policy.evaluate(tool.id, input, ctx, declaredPaths);
  const invokedAt = new Date();
  const start = Date.now();

  // An allow-list: only `Allow` runs the tool, or an `Escalate` the gate approved. Naming the
  // three refusals let any other verdict — a kind added later, or a policy answering outside the
  // union — fall through to execute. `Indeterminate` refuses with the rest: a rule that was never
  // consulted is not a rule that permitted this.
  if (policyDecision.verdict !== 'Allow') {
    // Escalate is the one refusal a human may lift, for this call only: the gate binds its decision
    // to this tool, this frozen input and these declared paths, and records it either way.
    const approval = policyDecision.verdict === 'Escalate' && deps.approvalGate
      ? await askGate(deps.approvalGate, {
          request: policyDecision.approvalRequest, toolId: tool.id, input, declaredPaths,
        })
      : undefined;
    if (!approves(policyDecision, approval)) return refuse(policyDecision, approval, tool, input, ctx, deps, invokedAt, start);
  }

  // The same confinement, on the path the tool resolved as it ran (a link inside the root that leads
  // into `.git`): the tool refuses before it touches anything, and the call is refused as above.
  let rawResult: ToolResult;
  try {
    rawResult = await tool.execute(input, ctx);
  } catch (err: unknown) {
    if (err instanceof PathConfinementError) return refuse(confinementDeny(err), undefined, tool, input, ctx, deps, invokedAt, start);
    throw err;
  }
  const result: ToolResult = {
    ...rawResult,
    stdout:   redactSecrets(rawResult.stdout),
    stderr:   redactSecrets(rawResult.stderr),
    metadata: redactCredentialsRecord(rawResult.metadata),
  };

  await deps.attestor.record({
    toolId:         tool.id,
    agentId:        ctx.agentId,
    runId:          ctx.runId,
    taskId:         ctx.taskId,
    input:          redactCredentialsRecord(input),
    result,
    invokedAt,
    durationMs:     Date.now() - start,
    policyDecision,
  });

  return result;
}

/** The rule id a built-in confinement refusal is recorded under: it is no policy file's rule. */
const BUILTIN_GIT_DIR_RULE = 'builtin:git-dir';

/** A tool's own confinement refusal, as the `Deny` it is recorded and reported as. */
function confinementDeny(err: PathConfinementError): Refusal {
  return { verdict: 'Deny', reason: err.message, ruleId: BUILTIN_GIT_DIR_RULE };
}

/**
 * Records a refused call, then throws it as a `PolicyViolationError` for the loop to hand back to the
 * model. Attested before the throw: a bundle that lists only the calls that ran cannot show that the
 * gate ever refused one.
 */
async function refuse(
  decision: Refusal,
  approval: ApprovalOutcome | undefined,
  tool: ToolPlugin,
  input: ToolInput,
  ctx: ToolContext,
  deps: GatedExecDeps,
  invokedAt: Date,
  start: number,
): Promise<never> {
  await deps.attestor.record({
    toolId:         tool.id,
    agentId:        ctx.agentId,
    runId:          ctx.runId,
    taskId:         ctx.taskId,
    input:          redactCredentialsRecord(input),
    result:         refusedResult(decision, approval),
    invokedAt,
    durationMs:     Date.now() - start,
    policyDecision: decision,
  });
  throw new PolicyViolationError(decision);
}

type Refusal = Exclude<PolicyDecision, { verdict: 'Allow' }>;

/**
 * The gate's outcome, or a refusal when the gate throws or answers no outcome at all. The handle
 * promises neither, but a gate that breaks it has decided nothing, and the call is still refused
 * on the record — a raw error here would end the node with no trace of the escalation.
 */
async function askGate(gate: ApprovalGateHandle, ask: ApprovalAsk): Promise<ApprovalOutcome> {
  let failure: string;
  try {
    const outcome = await gate.decide(ask);
    const given: unknown = outcome;
    if (typeof given === 'object' && given !== null) return outcome;
    failure = `it answered ${given === null ? 'null' : typeof given} instead of an outcome`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const requestId: unknown = ask.request?.id;
  return {
    approved: false, status: 'Rejected', requestId: typeof requestId === 'string' ? requestId : '',
    requestHash: '', reason: `the approval gate failed: ${failure}`,
  };
}

/**
 * Strictly `true`, and for the request this verdict carries: an outcome for another request, or a
 * gate answering something truthy, has approved nothing here.
 */
function approves(decision: Refusal, approval: ApprovalOutcome | undefined): boolean {
  return decision.verdict === 'Escalate' && approval !== undefined && approval.approved === true
    && approval.requestId === decision.approvalRequest?.id;
}

/**
 * What a refused call leaves in the bundle where an executed call leaves its output. Exit code 1
 * and an empty stdout, as the loop reports a refusal to the model; `metadata.refused` is what
 * tells it apart from a call that ran and failed. An Escalate the gate refused also says what the
 * gate decided; the decision itself is in the bundle's `approvals`.
 */
function refusedResult(decision: Refusal, approval: ApprovalOutcome | undefined): ToolResult {
  const ruleId = refusingRuleId(decision);
  const gate = approval ? ` — approval ${approval.status}: ${approval.reason}` : '';
  return {
    stdout:   '',
    stderr:   redactSecrets(`policy ${decision.verdict}: ${decision.reason}${gate}`),
    exitCode: 1,
    duration: 0,
    metadata: {
      refused: true,
      ...(ruleId !== undefined ? { ruleId } : {}),
      ...(approval ? { approval: approval.status } : {}),
    },
  };
}

/** The rule behind a refusal, where the decision names one; `Deny` carries none today. */
function refusingRuleId(decision: Refusal): string | undefined {
  switch (decision.verdict) {
    // `?.` because the decision comes from whatever implements the policy handle, and a malformed
    // one must still be recorded and refused rather than turn the refusal into a TypeError.
    case 'Deny':          return decision.ruleId;
    case 'Escalate':      return decision.approvalRequest?.policyRuleId;
    case 'Indeterminate': return decision.ruleId;
    default:              return undefined;
  }
}

/** Freezes `value` and every object or array reachable from it, in place. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}
