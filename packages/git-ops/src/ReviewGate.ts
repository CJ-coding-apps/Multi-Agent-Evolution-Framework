import type { CliAdapter, AdapterInvokeOptions, TaskId, RunId } from '@maf/types';
import type { WorktreeManager } from './WorktreeManager.js';

export interface ReviewGateConfig {
  adapter:        CliAdapter;
  projectRoot:    string;
  reviewPrompt?:  string;
  timeoutMs?:     number;
}

export interface ReviewResult {
  approved:    boolean;
  reasoning:   string;
  suggestions: string[];
}

const DEFAULT_REVIEW_PROMPT = `You are a code reviewer. Review the following diff and respond with:
1. APPROVED or REJECTED on the first line
2. A brief reasoning paragraph
3. A list of specific suggestions (if any)

Be concise. Focus on correctness, security, and maintainability.`;

export class ReviewGate {
  constructor(private readonly config: ReviewGateConfig) {}

  async review(taskId: TaskId, runId: RunId, worktrees: WorktreeManager): Promise<ReviewResult> {
    const diff = await worktrees.harvest(taskId).catch(() => '');
    if (!diff) return { approved: true, reasoning: 'No changes to review.', suggestions: [] };

    const invokeOpts: AdapterInvokeOptions = {
      prompt:      `Please review this diff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
      systemPrompt: this.config.reviewPrompt ?? DEFAULT_REVIEW_PROMPT,
      workingDir:   this.config.projectRoot,
      timeoutMs:    this.config.timeoutMs ?? 120_000,
    };

    const result = await this.config.adapter.invoke(invokeOpts);
    return this.parseReview(result.output);
  }

  private parseReview(output: string): ReviewResult {
    const lines = output.trim().split('\n');
    const verdict = lines[0]?.trim().toUpperCase() ?? '';
    const approved = verdict.includes('APPROVED') && !verdict.includes('REJECTED');

    const suggestions: string[] = [];
    let inSuggestions = false;
    const reasoningLines: string[] = [];

    for (const line of lines.slice(1)) {
      if (/^\d+\.\s/.test(line) || /^[-*]\s/.test(line)) {
        inSuggestions = true;
        suggestions.push(line.replace(/^[\d\-*\.]+\s*/, '').trim());
      } else if (!inSuggestions && line.trim()) {
        reasoningLines.push(line.trim());
      }
    }

    return { approved, reasoning: reasoningLines.join(' '), suggestions };
  }
}
