import { createHash } from 'node:crypto';
import type { CliAdapter, LcmMessage, ModelSurface } from '@maf/types';
import { redactCredentials, TransportError } from '@maf/types';
import type { SummaryOutput } from './summarizer.js';
import {
  byteLength, MAX_SUMMARY_ARGV_BYTES, MAX_SUMMARY_PROMPT_BYTES, SUMMARY_ARGV_ALLOWANCE_BYTES,
} from './summarizer.js';

// D-17: summaries come from the run's adapter, not from a local stub. The CLI wires this to the
// same `CliAdapter` the run executes with, and to the model the run was given (or the one the
// `lcm` section names), so a summary is produced by the backend the operator chose and its tokens
// are the backend's own count.
//
// WP-3.2 F7: this is a model-text path like the transcript, so credentials are masked on the way
// in (nothing in the prompt) and on the way out (nothing a model repeated lands in the store).

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
 *
 * Two refusals are deliberate:
 *  - a transport failure is rethrown as the typed `TransportError` it was, so the caller that
 *    retries transport failures (D-06, WP-3.2 F5) can recognise it after it crossed this seam;
 *  - an empty summary throws, because compaction that silently produced nothing would drop the
 *    messages it was asked to preserve.
 *
 * The backend's `modelSurface` travels with the summary (F1): the engine records the call, and the
 * digests of what was sent and returned are the record's evidence.
 */
export function createAdapterSummarizer(
  options: AdapterSummarizerOptions,
): (messages: LcmMessage[], depth: number) => Promise<SummaryOutput> {
  return async (messages, depth) => {
    if (messages.length === 0) {
      throw new Error('LCM summarization was asked to summarize no messages.');
    }
    const systemPrompt = depth === 0
      ? SUMMARY_SYSTEM_PROMPT
      : `${SUMMARY_SYSTEM_PROMPT}\nThese are summaries of earlier summaries: preserve every fact they already compressed.`;
    const prompt = boundedPrompt(
      messages.map((m) => `[${m.role.toUpperCase()}] ${redactCredentials(m.content)}`).join('\n'),
      systemPrompt,
      'LCM summarization',
    );

    const result = await options.adapter.invoke({
      prompt,
      systemPrompt,
      workingDir: options.workingDir,
      timeoutMs: options.timeoutMs ?? 120_000,
      nativeTools: false,
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    if (!result.success) {
      // Preserve the class: the scheduler retries a `TransportError` and only a `TransportError`
      // (D-06). Wrapping it in a plain Error turned a retryable timeout into a terminal failure.
      if (result.transportError) {
        throw new TransportError(
          `LCM summarization failed: the ${options.adapter.name} adapter reported a transport failure: ` +
          result.transportError.message,
          { cause: result.transportError },
        );
      }
      throw new Error(
        `LCM summarization failed: the ${options.adapter.name} adapter exited ${result.exitCode}.`,
      );
    }
    const content = redactCredentials(result.output.trim());
    if (content === '') {
      throw new Error(`LCM summarization failed: the ${options.adapter.name} adapter returned an empty summary.`);
    }
    // R6: not every backend reports a surface (ollama and openrouter return none today). A summary
    // is a model call like any other, so one is recorded from what this layer knows: the two prompts
    // and the output it was handed, and the model it asked for. MAF composed no tool catalogue for
    // a text-only call, which is what `''` means here.
    const surface: ModelSurface = result.modelSurface ?? {
      systemPromptSha256: sha256(systemPrompt),
      toolCatalog: '',
      promptSha256: sha256(prompt),
      outputSha256: sha256(result.output),
      argv: [],
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
    return {
      content,
      ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
      surface,
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
  };
}

/**
 * The sub-agent a caller can supply for Agentic-Map. It is a separate, tool-less model call —
 * deliberately not the run's coder turn — so a summarization cannot act on the tree.
 */
export function createAdapterSubAgent(
  options: AdapterSummarizerOptions,
): (systemPrompt: string, userMessages: string[]) => Promise<SummaryOutput> {
  return async (systemPrompt, userMessages) => {
    const prompt = boundedPrompt(
      userMessages.map((message) => redactCredentials(message)).join('\n\n'),
      systemPrompt,
      'LCM Agentic-Map',
    );
    const result = await options.adapter.invoke({
      prompt,
      systemPrompt,
      workingDir: options.workingDir,
      timeoutMs: options.timeoutMs ?? 120_000,
      nativeTools: false,
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    if (!result.success) {
      if (result.transportError) {
        throw new TransportError(
          `LCM Agentic-Map failed: the ${options.adapter.name} adapter reported a transport failure: ` +
          result.transportError.message,
          { cause: result.transportError },
        );
      }
      throw new Error(
        `LCM Agentic-Map failed: the ${options.adapter.name} adapter exited ${result.exitCode}.`,
      );
    }
    const content = redactCredentials(result.output.trim());
    if (content === '') {
      // The same rule as the LLM summarizer: a compaction that produced nothing must fail, not
      // write an empty summary over the messages it was asked to preserve.
      throw new Error(`LCM Agentic-Map failed: the ${options.adapter.name} adapter returned an empty summary.`);
    }
    // The backend's count and surface travel with the text (F1): Agentic-Map's summary is recorded
    // in the same array as every role call, and its tokens are charged to the budget that paid.
    // R6: a backend that reports no surface still gets one recorded, as on the LLM-Map path.
    const surface: ModelSurface = result.modelSurface ?? {
      systemPromptSha256: sha256(systemPrompt),
      toolCatalog: '',
      promptSha256: sha256(prompt),
      outputSha256: sha256(result.output),
      argv: [],
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
    return {
      content,
      ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
      surface,
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
  };
}

/**
 * Refuses a prompt over the command-line ceiling (F4, R3) rather than letting the operating system
 * refuse the process start with E2BIG, which names neither the package nor the reason.
 *
 * The measure is bytes, not characters, and it is the whole command line rather than the prompt
 * alone. The claude adapter hands the prompt to the backend as one argv argument
 * (`-p -- <prompt>`) and has no stdin form for this call — codex is the adapter that reads stdin, and
 * a summary is made by the run's own adapter — so the prompt, the system prompt, the flags and the
 * model name all share the limit. A `'中'` is one character and three bytes, which is exactly how a
 * 64 KiB character cap became a ~192 KiB argument.
 *
 * The engine chunks below {@link MAX_SUMMARY_PROMPT_BYTES}, so reaching this sentence is a defect
 * in the caller, and it should fail as one.
 */
function boundedPrompt(prompt: string, systemPrompt: string, what: string): string {
  const promptBytes = byteLength(prompt);
  if (promptBytes > MAX_SUMMARY_PROMPT_BYTES) {
    throw new Error(
      `${what} built a ${promptBytes}-byte prompt, over the ${MAX_SUMMARY_PROMPT_BYTES}-byte ` +
      `cap for one backend argument. The engine is expected to chunk below it.`,
    );
  }
  const argvBytes = promptBytes + byteLength(systemPrompt) + SUMMARY_ARGV_ALLOWANCE_BYTES;
  if (argvBytes > MAX_SUMMARY_ARGV_BYTES) {
    throw new Error(
      `${what} built a command line of about ${argvBytes} bytes (prompt, system prompt and the ` +
      `summarizer's own flags), over the ${MAX_SUMMARY_ARGV_BYTES}-byte cap for one process start.`,
    );
  }
  return prompt;
}

/** The hex digest a surface records; the same construction the adapters use. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
