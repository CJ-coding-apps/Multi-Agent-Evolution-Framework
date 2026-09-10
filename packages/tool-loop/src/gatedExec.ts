import type {
  ToolPlugin, ToolInput, ToolResult, ToolContext,
  PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { redactSecrets, redactCredentialsRecord } from '@maf/processors';

export interface GatedExecDeps {
  policy:   PolicyEngineHandle;
  attestor: AttestorHandle;
}

/**
 * executeToolGated — the single gated execution path shared by ToolLoop and
 * InProcessAgentLoop (HARNESSX_INTEGRATION_PLAN.md §4.1: no behavior duplication).
 *
 * Order is load-bearing: policy FIRST (Deny/Escalate throw PolicyViolationError,
 * nothing executes), then tool.execute, then attestation. Processor-mediated
 * input edits happen upstream of this function — policy always sees the final
 * input.
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
  const policyDecision = await deps.policy.evaluate(tool.id, input, ctx);
  const invokedAt = new Date();
  const start = Date.now();

  if (policyDecision.verdict === 'Deny' || policyDecision.verdict === 'Escalate') {
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
