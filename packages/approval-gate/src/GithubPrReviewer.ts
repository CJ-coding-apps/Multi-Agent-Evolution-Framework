import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ApprovalRequest, ApprovalDecision } from '@maf/types';

const execFileAsync = promisify(execFile);

export interface GithubPrReviewerConfig {
  reviewers?:     string[];   // GitHub logins
  labels?:        string[];
  draft?:         boolean;
}

export class GithubPrReviewer {
  constructor(private readonly config: GithubPrReviewerConfig = {}) {}

  async createPr(request: ApprovalRequest): Promise<string> {
    const reviewerArgs = (this.config.reviewers ?? []).flatMap((r) => ['--reviewer', r]);
    const labelArgs    = (this.config.labels    ?? []).flatMap((l) => ['--label', l]);
    const draftArgs    = this.config.draft ? ['--draft'] : [];

    const body = this.buildPrBody(request);

    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--title', `[MAF Approval] ${request.description.slice(0, 60)}`,
      '--body',  body,
      ...reviewerArgs,
      ...labelArgs,
      ...draftArgs,
    ]);
    return stdout.trim();
  }

  async checkPrStatus(prUrl: string, requestId: string): Promise<ApprovalDecision | undefined> {
    const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
    if (!prNumber) return undefined;

    const { stdout } = await execFileAsync('gh', ['pr', 'view', prNumber, '--json', 'state,reviews,mergedBy']);
    const data = JSON.parse(stdout) as {
      state: string;
      reviews: Array<{ state: string; author: { login: string }; body: string }>;
      mergedBy?: { login: string };
    };

    if (data.state === 'MERGED') {
      const reviewer = data.mergedBy?.login ?? data.reviews.find((r) => r.state === 'APPROVED')?.author.login ?? 'github';
      return { requestId, status: 'Approved', reviewer, decidedAt: new Date() };
    }
    if (data.state === 'CLOSED') {
      return { requestId, status: 'Rejected', reviewer: 'github', decidedAt: new Date() };
    }
    return undefined;
  }

  private buildPrBody(request: ApprovalRequest): string {
    const diffBlock = request.diff ? `\n\n\`\`\`diff\n${request.diff.slice(0, 4000)}\n\`\`\`` : '';
    return [
      `## MAF Approval Request`,
      ``,
      `**Run:** ${request.runId}`,
      `**Task:** ${request.taskId}`,
      `**Policy Rule:** ${request.policyRuleId}`,
      `**Requested By:** ${request.requestedBy}`,
      `**Description:** ${request.description}`,
      diffBlock,
    ].join('\n');
  }
}
