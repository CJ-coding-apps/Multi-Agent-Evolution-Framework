import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalProvider, PendingApproval, ProviderAnswer } from '../ApprovalGate.js';

export interface HeadlessProviderOptions {
  /** `<project>/.maf/approvals/pending`. */
  pendingDir: string;
  /** Why no one can be asked; recorded in the file and the decision. */
  reason:     string;
}

export const HEADLESS_REVIEWER = 'headless';

/**
 * No terminal, no human (D-02): every request is refused without a prompt, and written to
 * `<pendingDir>/<id>.json` so an operator can see afterwards what the run would have needed. The
 * file is an audit record, not a queue — approving it later approves nothing.
 */
export class HeadlessApprovalProvider implements ApprovalProvider {
  constructor(private readonly options: HeadlessProviderOptions) {}

  async ask(pending: PendingApproval): Promise<ProviderAnswer> {
    const file = path.join(this.options.pendingDir, `${pending.requestId}.json`);
    const record = {
      request:       pending.request,
      requestHash:   pending.requestHash,
      toolId:        pending.toolId,
      declaredPaths: pending.declaredPaths,
      timestamp:     new Date().toISOString(),
      reason:        this.options.reason,
    };
    let recorded: string;
    try {
      await mkdir(this.options.pendingDir, { recursive: true });
      // `wx`: a record already there belongs to an earlier request and is not overwritten.
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      recorded = `the request is recorded at ${file}`;
    } catch (err) {
      // The refusal stands either way; only the audit copy is missing, and the decision says so.
      recorded = `the request could not be recorded at ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      requestId: pending.requestId, requestHash: pending.requestHash,
      approved: false, reviewer: HEADLESS_REVIEWER, reason: `${this.options.reason}; ${recorded}`,
    };
  }
}
