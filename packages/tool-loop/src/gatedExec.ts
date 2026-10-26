import type {
  ToolPlugin, ToolInput, ToolResult, ToolContext,
  PolicyEngineHandle, AttestorHandle, PolicyDecision, ApprovalAsk, ApprovalGateHandle, ApprovalOutcome,
} from '@maf/types';
import { PathConfinementError, PathEscapeError, ToolDeclarationError, toolFailureMessage, toolInputProblem } from '@maf/types';
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
 * Order is load-bearing: the input FIRST — a call whose input does not match the tool's
 * `inputSchema` is answered with a failed result (attested, returned, not thrown) and nothing
 * else happens — then policy — anything but Allow (or an Escalate the
 * approval gate approves) is attested as a refusal and then thrown as
 * PolicyViolationError, and nothing executes — then tool.execute, then
 * attestation. A tool that throws while it runs is answered the same way a tool that
 * returns a failure is: a failed result, `<tool id> failed: <message>`, recorded with the
 * verdict the policy gave and returned. A tool's built-in confinement (`PathConfinementError`, from
 * `declaredPaths` or from `execute` before it acts) is refused the same way policy refuses, as a
 * `Deny` under rule id `builtin:git-dir`; so is a path the tool resolved outside the project root
 * as it ran (`PathEscapeError`), under `builtin:path-escape`. A tool that cannot declare what it will
 * touch at all (`ToolDeclarationError`) is refused under `builtin:declaration`: policy was never asked, so
 * no rule could have covered the call, and an undeclared call is not an allowed one. The approved declaration
 * is handed to `execute` on its context (`ToolContext.approvedPaths`), and a tool that recomputes it where it
 * acts refuses under the same rule id when the two sets differ — a call that would write a set the policy did
 * not see is not covered by the Allow it earned. Processor-mediated
 * input edits happen upstream of this function — policy always sees the final input.
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

  // The input before anything reads it. A field the tool does not take, or one it needs and was not
  // given, is a call the model can correct, not one to judge: `{path, patch}` for patch.apply declared
  // no paths (so policy allowed it) and then threw a TypeError from `writeFile(tmp, undefined)`, which
  // ended the node. Answered, not thrown, so the loop hands it back and goes on; a tool with no schema
  // is not checked.
  if (tool.inputSchema !== undefined) {
    const problem = toolInputProblem(String(tool.id), tool.inputSchema, input);
    if (problem !== undefined) {
      return answerMalformed(redactSecrets(problem), BUILTIN_INPUT_SCHEMA_RULE, tool, input, ctx, deps);
    }
  }

  // The tool's own declaration, computed before any rule is consulted. An error here (a tool
  // that does not declare, a declaration that throws) propagates: failing to evaluate policy
  // is not permission to skip it. The one exception is the tool's built-in confinement refusing
  // a path, which is a verdict, not a failure: it is refused on the record like a `Deny`.
  let declaredPaths: string[];
  try {
    // The caller's own context, so a declaration that reads the tree (a path that is a symlink
    // today) is refused here, as a verdict, rather than earned an Allow that `execute` declines.
    declaredPaths = tool.declaredPaths(input, ctx);
  } catch (err: unknown) {
    const deny = builtinRefusal(err);
    if (deny !== undefined) return refuse(deny, undefined, tool, input, ctx, deps, new Date(), Date.now());
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
  // into `.git`, or one swapped in after policy confined the spelling that now leads out of the root):
  // the tool refuses before it touches anything, and the call is refused as above — a refusal, never
  // a failed call recorded under the `Allow` the spelling had earned.
  // The approved set travels with the call, on a copy of the context, so a tool that can recompute
  // its declaration where it acts can refuse when the two differ. The policy and the approval gate
  // were asked about the caller's context, and a tool must not be able to change what they saw.
  // The array itself is frozen (on a copy, so the caller's own array is untouched): it is the record
  // of what was approved, and a policy, an approval gate or a tool that kept a handle to it must not
  // be able to change that record by writing to the array.
  const approvedPaths: readonly string[] = Object.freeze([...declaredPaths]);
  let rawResult: ToolResult;
  try {
    rawResult = await tool.execute(input, { ...ctx, approvedPaths });
  } catch (err: unknown) {
    const deny = builtinRefusal(err);
    if (deny !== undefined) return refuse(deny, undefined, tool, input, ctx, deps, invokedAt, start);
    // A refusal raised inside a tool is still a refusal, and keeps the refusal's path.
    if (err instanceof PolicyViolationError) throw err;
    // Anything else is the tool failing while it ran — `fs.read` of a file that is not there, a bug in
    // the tool itself — and the model can act on that. Thrown, it ended the node: a model checking
    // whether `hello.js` existed before writing it failed the run. Answered as a failed call instead,
    // and recorded, with the verdict that let it run, like any call that ran and failed.
    rawResult = {
      stdout: '', stderr: toolFailureMessage(String(tool.id), err), exitCode: 1,
      duration: Date.now() - start, metadata: { threw: true },
    };
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

/** The rule ids a built-in refusal is recorded under: they are no policy file's rules. */
const BUILTIN_GIT_DIR_RULE = 'builtin:git-dir';
const BUILTIN_PATH_ESCAPE_RULE = 'builtin:path-escape';
/**
 * A tool that cannot say which paths it will touch. The policy was never asked, so no rule could
 * have covered the call — and a call no rule can see is refused, not run.
 */
const BUILTIN_DECLARATION_RULE = 'builtin:declaration';

/** The rule id a call whose input does not match the tool's schema is recorded under. */
const BUILTIN_INPUT_SCHEMA_RULE = 'builtin:input-schema';

/**
 * Records a call whose input the tool does not take, and returns the failed result the model is
 * handed: `problem` as stderr, exit code 1. Recorded as `Indeterminate` — the policy was not asked,
 * because a call it cannot read is no call it could judge, and `Allow` would say it had been — with
 * `metadata.refused`, as every call that did not run is marked.
 */
async function answerMalformed(
  problem: string,
  ruleId: string,
  tool: ToolPlugin,
  input: ToolInput,
  ctx: ToolContext,
  deps: GatedExecDeps,
): Promise<ToolResult> {
  const result: ToolResult = {
    stdout:   '',
    stderr:   problem,
    exitCode: 1,
    duration: 0,
    metadata: { refused: true, ruleId },
  };
  await deps.attestor.record({
    toolId:         tool.id,
    agentId:        ctx.agentId,
    runId:          ctx.runId,
    taskId:         ctx.taskId,
    input:          redactCredentialsRecord(input),
    result,
    invokedAt:      new Date(),
    durationMs:     0,
    policyDecision: { verdict: 'Indeterminate', reason: problem, ruleId },
  });
  return result;
}

/**
 * A tool's own refusal, as the `Deny` it is recorded and reported as: a path into `.git`, a path that
 * resolves outside the project root, or a declaration the tool cannot produce at all. `undefined` for
 * any other error.
 */
function builtinRefusal(err: unknown): Refusal | undefined {
  if (err instanceof PathConfinementError) return { verdict: 'Deny', reason: err.message, ruleId: BUILTIN_GIT_DIR_RULE };
  if (err instanceof PathEscapeError) return { verdict: 'Deny', reason: err.message, ruleId: BUILTIN_PATH_ESCAPE_RULE };
  if (err instanceof ToolDeclarationError) return { verdict: 'Deny', reason: err.message, ruleId: BUILTIN_DECLARATION_RULE };
  return undefined;
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
