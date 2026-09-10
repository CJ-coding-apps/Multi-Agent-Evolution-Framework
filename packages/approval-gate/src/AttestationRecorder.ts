import type { ReviewAttestation, ApprovalRequest } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';

export class AttestationRecorder {
  constructor(private readonly graph: MemoryGraph) {}

  async record(attestation: ReviewAttestation, request: ApprovalRequest): Promise<string> {
    const nodeId = await this.graph.addNode({
      kind:  'Approval',
      label: `approval:${attestation.requestId}`,
      properties: {
        requestId:  attestation.requestId,
        reviewer:   attestation.decision.reviewer,
        status:     attestation.decision.status,
        diffHash:   attestation.diffHash,
        commitHash: attestation.commitHash,
        taskId:     request.taskId,
        policyRule: request.policyRuleId,
        decidedAt:  attestation.decision.decidedAt.toISOString(),
      },
      runId: request.runId,
    });

    // Link approval → run
    const runRows = await this.graph.query(
      `MATCH (n:MemoryNode {kind: 'Run', run_id: '${request.runId}'}) RETURN n.id LIMIT 1`,
      {},
    ) as Array<Record<string, unknown>>;

    if (runRows[0]) {
      const runNodeId = String(runRows[0]['n.id'] ?? '');
      await this.graph.addEdge({ fromId: runNodeId, toId: nodeId, relation: 'APPROVED_BY', weight: 1, metadata: {} });
    }

    return nodeId;
  }

  async getApprovals(runId: string): Promise<Array<Record<string, unknown>>> {
    return this.graph.query(
      `MATCH (n:MemoryNode {kind: 'Approval', run_id: '${runId}'}) RETURN n LIMIT 100`,
      {},
    ) as Promise<Array<Record<string, unknown>>>;
  }
}
