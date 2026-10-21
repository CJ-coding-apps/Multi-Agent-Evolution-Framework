import type { CliAdapter, LcmMessage } from '@maf/types';
import type { SummaryOutput } from './summarizer.js';

// D-17: summaries come from the run's adapter, not from a local stub. The CLI wires this to the
// same `CliAdapter` the run executes with, and to the model the run was given (or the one the
// `lcm` section names), so a summary is produced by the backend the operator chose and its tokens
// are the backend's own count.

const SUMMARY_SYSTEM_PROMPT = `You are a context summarization agent.
Your job is to distill a sequence of conversation messages into a dense, accurate summary.
Preserve all factual claims, decisions made, errors encountered, and solutions found.
Output in plain prose. Do not include metadata or timestamps.`;

export interface AdapterSummarizerOptions {
  adapter:    CliAdapter;
  workingDir: string;
  timeoutMs?: number;
  model?:     string;
}

/**
 * A summarizer backed by the run's adapter. It asks for text only (`nativeTools: false`): a
 * summarization call must not be able to change the tree, and it has no tools to do it with.
 * A failed or empty call throws — compaction that silently produced nothing would drop the
 * messages it was asked to preserve.
 */
export function createAdapterSummarizer(
  options: AdapterSummarizerOptions,
): (messages: LcmMessage[], depth: number) => Promise<SummaryOutput> {
  return async (messages, depth) => {
    if (messages.length === 0) {
      throw new Error('LCM summarization was asked to summarize no messages.');
    }
    const prompt = messages
      .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
      .join('\n');
    const systemPrompt = depth === 0
      ? SUMMARY_SYSTEM_PROMPT
      : `${SUMMARY_SYSTEM_PROMPT}\nThese are summaries of earlier summaries: preserve every fact they already compressed.`;

    const result = await options.adapter.invoke({
      prompt,
      systemPrompt,
      workingDir: options.workingDir,
      timeoutMs: options.timeoutMs ?? 120_000,
      nativeTools: false,
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    if (!result.success) {
      throw new Error(
        `LCM summarization failed: the ${options.adapter.name} adapter exited ${result.exitCode}` +
        `${result.transportError ? ` (${result.transportError.message})` : ''}.`,
      );
    }
    const content = result.output.trim();
    if (content === '') {
      throw new Error(`LCM summarization failed: the ${options.adapter.name} adapter returned an empty summary.`);
    }
    return {
      content,
      ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
    };
  };
}

/**
 * The sub-agent a caller can supply for Agentic-Map. It is a separate, tool-less model call —
 * deliberately not the run's coder turn — so a summarization cannot act on the tree.
 */
export function createAdapterSubAgent(
  options: AdapterSummarizerOptions,
): (systemPrompt: string, userMessages: string[]) => Promise<string> {
  return async (systemPrompt, userMessages) => {
    const result = await options.adapter.invoke({
      prompt: userMessages.join('\n\n'),
      systemPrompt,
      workingDir: options.workingDir,
      timeoutMs: options.timeoutMs ?? 120_000,
      nativeTools: false,
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    if (!result.success) {
      throw new Error(
        `LCM Agentic-Map failed: the ${options.adapter.name} adapter exited ${result.exitCode}.`,
      );
    }
    const content = result.output.trim();
    if (content === '') {
      // The same rule as the LLM summarizer: a compaction that produced nothing must fail, not
      // write an empty summary over the messages it was asked to preserve.
      throw new Error(`LCM Agentic-Map failed: the ${options.adapter.name} adapter returned an empty summary.`);
    }
    return content;
  };
}
