import type {
  ToolPlugin, ToolInput, ToolResult, ToolContext,
  PolicyEngineHandle, AttestorHandle, PolicyDecision,
} from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { redactSecrets, redactCredentialsRecord } from '@maf/processors';

export interface GatedExecDeps {
  policy:   PolicyEngineHandle;
  attestor: AttestorHandle;
}

/**
 * executeToolGated — the single gated execution path shared by ToolLoop and
 * InProcessAgentLoop: no behavior duplication between them (README.md,
 * "In-process execution & the tool-call protocol").
 *
 * Order is load-bearing: policy FIRST — anything but Allow is attested as a
 * refusal and then thrown as PolicyViolationError, and nothing executes — then
 * tool.execute, then attestation. Processor-mediated input edits happen upstream
 * of this function — policy always sees the final input.
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
  // is not permission to skip it.
  const declaredPaths = tool.declaredPaths(input);

  const policyDecision = await deps.policy.evaluate(tool.id, input, ctx, declaredPaths);
  const invokedAt = new Date();
  const start = Date.now();

  // An allow-list: only `Allow` runs the tool. Naming the three refusals let any other verdict —
  // a kind added later, or a policy answering outside the union — fall through to execute.
  // `Indeterminate` refuses with the rest: a rule that was never consulted is not a rule that
  // permitted this.
  if (policyDecision.verdict !== 'Allow') {
    // Attested before the throw: a bundle that lists only the calls that ran cannot show that the
    // gate ever refused one.
    await deps.attestor.record({
      toolId:         tool.id,
      agentId:        ctx.agentId,
      runId:          ctx.runId,
      taskId:         ctx.taskId,
      input:          redactCredentialsRecord(input),
      result:         refusedResult(policyDecision),
      invokedAt,
      durationMs:     Date.now() - start,
      policyDecision,
    });
    throw new PolicyViolationError(policyDecision);
  }

  const rawResult = await tool.execute(input, ctx);
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

type Refusal = Exclude<PolicyDecision, { verdict: 'Allow' }>;

/**
 * What a refused call leaves in the bundle where an executed call leaves its output. Exit code 1
 * and an empty stdout, as the loop reports a refusal to the model; `metadata.refused` is what
 * tells it apart from a call that ran and failed.
 */
function refusedResult(decision: Refusal): ToolResult {
  const ruleId = refusingRuleId(decision);
  return {
    stdout:   '',
    stderr:   redactSecrets(`policy ${decision.verdict}: ${decision.reason}`),
    exitCode: 1,
    duration: 0,
    metadata: { refused: true, ...(ruleId !== undefined ? { ruleId } : {}) },
  };
}

/** The rule behind a refusal, where the decision names one; `Deny` carries none today. */
function refusingRuleId(decision: Refusal): string | undefined {
  switch (decision.verdict) {
    // `?.` because the decision comes from whatever implements the policy handle, and a malformed
    // one must still be recorded and refused rather than turn the refusal into a TypeError.
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
