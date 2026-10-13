import type { ApprovalStatus, ReviewAttestation } from '@maf/types';
import { makeCommitHash } from '@maf/types';
import { buildInTotoStatement, componentId } from '@maf/attestation';

/** Where decisions go: `Attestor` satisfies it with its existing `addApproval`. */
export interface ApprovalSink {
  addApproval(attestation: ReviewAttestation): void;
}

export interface SettledApproval {
  requestId:     string;
  requestHash:   string;
  status:        ApprovalStatus;
  reviewer:      string;
  reason:        string;
  toolId:        string;
  policyRuleId:  string;
  declaredPaths: readonly string[];
  decidedAt:     Date;
}

// An approval binds one tool call, not a commit; the request hash is its subject, so no commit is
// claimed. All zeros is the `ReviewAttestation` shape's way of saying so (WP-2.8 owns the shape).
const NO_COMMIT = makeCommitHash('0'.repeat(40));

/**
 * Turns every settled request — approved, refused, timed out or refused headless — into a
 * `ReviewAttestation` in the run's bundle. `diffHash` carries the request hash: it is the digest
 * of the change the decision was about, and what a reader matches against the call's input.
 */
export class AttestationRecorder {
  constructor(private readonly sink: ApprovalSink) {}

  record(settled: SettledApproval): ReviewAttestation {
    const attestation: ReviewAttestation = {
      requestId:  settled.requestId,
      decision: {
        requestId: settled.requestId,
        status:    settled.status,
        reviewer:  settled.reviewer,
        comment:   settled.reason,
        decidedAt: settled.decidedAt,
      },
      commitHash: NO_COMMIT,
      diffHash:   settled.requestHash,
      intotoStmt: buildInTotoStatement(
        { [`tool-call:${settled.requestId}`]: settled.requestHash },
        { id: componentId('maf-approval-gate'), modelVersion: settled.reviewer },
        {
          configSource: { uri: `policy-rule:${settled.policyRuleId}`, digest: { sha256: settled.requestHash } },
          parameters:   { toolId: settled.toolId, declaredPaths: [...settled.declaredPaths], status: settled.status },
          environment:  {},
        },
      ),
    };
    this.sink.addApproval(attestation);
    return attestation;
  }
}
