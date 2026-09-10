import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import type {
  ApprovalRequest, ApprovalDecision, ApprovalStatus,
  ReviewAttestation, CommitHash,
} from '@maf/types';
import { makeCommitHash } from '@maf/types';
import { buildInTotoStatement } from '@maf/attestation';
import type { MemoryGraph } from '@maf/memory-graph';

const execFileAsync = promisify(execFile);

export class ApprovalTimeoutError extends Error {
  constructor(public readonly requestId: string) {
    super(`Approval request timed out: ${requestId}`);
  }
}

export class ApprovalRejectedError extends Error {
  constructor(public readonly requestId: string, public readonly reason?: string) {
    super(`Approval request rejected: ${requestId}`);
  }
}

export interface ApprovalGateConfig {
  graph:              MemoryGraph;
  defaultTimeoutMs?:  number;   // default 24 hours
  pollIntervalMs?:    number;   // default 60 seconds
  reviewers?:         string[]; // GitHub logins
}

export class ApprovalGate {
  private pending = new Map<string, ApprovalRequest>();

  constructor(private readonly config: ApprovalGateConfig) {}

  async requestApproval(request: ApprovalRequest): Promise<ReviewAttestation> {
    this.pending.set(request.id, request);

    // Try GitHub PR if gh CLI is available
    let prUrl: string | undefined;
    try {
      prUrl = await this.createGithubPr(request);
      request.prUrl = prUrl;
    } catch { /* gh CLI not available */ }

    // Poll for approval
    const timeoutMs   = this.config.defaultTimeoutMs ?? 24 * 60 * 60 * 1000;
    const pollInterval = this.config.pollIntervalMs ?? 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const decision = await this.checkPrStatus(request, prUrl);
      if (decision) {
        return this.finalizeDecision(request, decision);
      }
      await sleep(pollInterval);
    }

    this.pending.delete(request.id);
    throw new ApprovalTimeoutError(request.id);
  }

  // Called by human reviewer or CI system directly (non-GitHub flow)
  async submitDecision(requestId: string, reviewer: string, approved: boolean, comment?: string): Promise<void> {
    const request = this.pending.get(requestId);
    if (!request) throw new Error(`Unknown approval request: ${requestId}`);

    const decision: ApprovalDecision = {
      requestId,
      status:    approved ? 'Approved' : 'Rejected',
      reviewer,
      decidedAt: new Date(),
      ...(comment ? { comment } : {}),
    };

    // Store side-channel decision for the polling loop to pick up
    this.decisions.set(requestId, decision);
  }

  private decisions = new Map<string, ApprovalDecision>();

  private async checkPrStatus(request: ApprovalRequest, prUrl?: string): Promise<ApprovalDecision | undefined> {
    // Check side-channel first
    const direct = this.decisions.get(request.id);
    if (direct) { this.decisions.delete(request.id); return direct; }

    if (!prUrl) return undefined;

    try {
      // Extract PR number from URL
      const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
      if (!prNumber) return undefined;

      const { stdout } = await execFileAsync('gh', ['pr', 'view', prNumber, '--json', 'state,reviews']);
      const data = JSON.parse(stdout) as { state: string; reviews: Array<{ state: string; author: { login: string }; body: string }> };

      if (data.state === 'MERGED') {
        const approver = data.reviews.find((r) => r.state === 'APPROVED');
        return {
          requestId:  request.id,
          status:     'Approved',
          reviewer:   approver?.author.login ?? 'github',
          decidedAt:  new Date(),
        };
      }
      if (data.state === 'CLOSED') {
        return { requestId: request.id, status: 'Rejected', reviewer: 'github', decidedAt: new Date() };
      }
    } catch { /* gh unavailable or PR not found */ }

    return undefined;
  }

  private async finalizeDecision(
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): Promise<ReviewAttestation> {
    this.pending.delete(request.id);

    if (decision.status === 'Rejected') {
      throw new ApprovalRejectedError(request.id, decision.comment);
    }

    const currentHead = await this.getCurrentHead(request.runId);
    const diffHash = crypto.createHash('sha256').update(request.diff ?? '').digest('hex');

    const attestation: ReviewAttestation = {
      requestId:  request.id,
      decision,
      commitHash: currentHead,
      diffHash,
      intotoStmt: buildInTotoStatement(
        { [request.taskId]: diffHash },
        { id: `maf-approval-gate@0.1.0`, modelVersion: 'human' },
        { configSource: { uri: request.prUrl ?? '', digest: { sha256: diffHash } }, parameters: {}, environment: {} },
      ),
    };

    await this.config.graph.addNode({
      kind:       'Approval',
      label:      `approval:${request.id}`,
      properties: { requestId: request.id, reviewer: decision.reviewer, status: decision.status, diffHash },
      runId:      request.runId,
    });

    return attestation;
  }

  private async createGithubPr(request: ApprovalRequest): Promise<string> {
    const reviewerArgs = this.config.reviewers?.flatMap((r) => ['--reviewer', r]) ?? [];
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--title', `[MAF Approval] ${request.description.slice(0, 60)}`,
      '--body',  `## MAF Approval Request\n\n**Run:** ${request.runId}\n**Task:** ${request.taskId}\n**Policy:** ${request.policyRuleId}\n\n${request.diff ? '```diff\n' + request.diff + '\n```' : ''}`,
      ...reviewerArgs,
    ]);
    return stdout.trim();
  }

  private async getCurrentHead(_runId: string): Promise<CommitHash> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
      return makeCommitHash(stdout.trim());
    } catch {
      return makeCommitHash('0000000000000000000000000000000000000000');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
