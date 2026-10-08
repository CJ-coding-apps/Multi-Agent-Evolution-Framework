import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { TransportError } from '@maf/types';
import { BaseAdapter, failureTail } from '@maf/adapter-base';

interface OllamaChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaRequest {
  model:    string;
  messages: OllamaChatMessage[];
  stream:   boolean;
  options?: Record<string, unknown> | undefined;
}

interface OllamaResponse {
  message:    OllamaChatMessage;
  done:       boolean;
  eval_count: number;
}

interface OllamaStreamChunk {
  message: OllamaChatMessage;
  done:    boolean;
}

/** The request's own deadline, so an abort it caused is reported as the timeout it is. */
interface Deadline { signal: AbortSignal; ms: number }

/** undici reports every network failure as "fetch failed"; the reason is on its cause. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * `pending`, with every way of getting no answer — a refused or reset connection (no server on
 * the port), a DNS failure, a body cut off part-way, the request's own deadline — turned into a
 * TransportError. None of them says anything about the request, so the node may be retried on it
 * (D-06).
 */
async function answered<T>(url: string, pending: Promise<T>, deadline?: Deadline): Promise<T> {
  try {
    return await pending;
  } catch (err) {
    const message = deadline !== undefined && deadline.signal.aborted
      ? `Ollama was expected to answer ${url} within ${deadline.ms} ms, but it had not, so the request was aborted.`
      : `Ollama was expected to answer ${url}, but the request failed before an answer arrived: ${describe(err)}`;
    throw new TransportError(message, { cause: err });
  }
}

/** A 5xx is the server failing, not judging the request, so asking again can succeed (D-06). */
function serverFailure(url: string, status: number, body: string): TransportError {
  return new TransportError(
    `Ollama was expected to answer ${url}, but it failed with HTTP ${status}. Body tail: ${failureTail(body)}`,
  );
}

export interface OllamaAdapterOptions {
  baseUrl?: string;   // default: http://localhost:11434
  model?:   string;   // no default: falls back to OLLAMA_MODEL, else the first call is refused
}

export class OllamaAdapter extends BaseAdapter {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly defaultModel: string | undefined;

  constructor(opts: OllamaAdapterOptions = {}) {
    super();
    this.baseUrl      = opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
    // No fallback id: which models exist is the user's local install, not ours to guess. A
    // missing model is refused at the first call, not here, so the adapter can still be listed.
    this.defaultModel = opts.model   ?? process.env['OLLAMA_MODEL'];
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: false,
      supportsWorktrees:   false,
      inProcessLoop:       false,
      maxConcurrentTasks:  2,
      nativePlugins:       [],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch { return false; }
  }

  /** Ollama sampling knobs: num_predict (token budget) + temperature (determinism). */
  private optionsBag(options: AdapterInvokeOptions): { options?: Record<string, unknown> } {
    const bag: Record<string, unknown> = {};
    if (options.tokenBudget) bag['num_predict'] = options.tokenBudget;
    if (options.temperature !== undefined) bag['temperature'] = options.temperature;
    return Object.keys(bag).length > 0 ? { options: bag } : {};
  }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const start = Date.now();
    const messages = this.buildMessages(options);
    const body: OllamaRequest = {
      model:   this.resolveModel(options),
      messages,
      stream:  false,
      ...this.optionsBag(options),
    };

    const url = `${this.baseUrl}/api/chat`;
    const controller = new AbortController();
    const deadline: Deadline = { signal: controller.signal, ms: options.timeoutMs };
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await answered(url, fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      }), deadline);
      const text = await answered(url, res.text(), deadline);
      if (res.status >= 500) throw serverFailure(url, res.status, text);
      if (!res.ok) {
        // A 4xx is the server judging the request (an unknown model is a 404). Classifying those
        // is D-05's (0.4.0); until then it is a failed result, not a retry.
        return { success: false, output: text, toolCallLog: [], exitCode: res.status, duration: Date.now() - start };
      }
      const data = JSON.parse(text) as OllamaResponse;
      return {
        success:     true,
        output:      data.message.content,
        tokensUsed:  data.eval_count,
        toolCallLog: [] as ToolCallRecord[],
        exitCode:    0,
        duration:    Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  override async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const messages = this.buildMessages(options);
    const body: OllamaRequest = {
      model:   this.resolveModel(options),
      messages,
      stream:  true,
      ...this.optionsBag(options),
    };

    const url = `${this.baseUrl}/api/chat`;
    const res = await answered(url, fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }));

    if (res.status >= 500) throw serverFailure(url, res.status, await answered(url, res.text()));
    if (!res.ok || !res.body) throw new Error(`Ollama stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await answered(url, reader.read());
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as OllamaStreamChunk;
          if (chunk.message?.content) yield chunk.message.content;
        } catch { /* skip malformed */ }
      }
    }
  }

  /** Runs before the request body exists, so a call with no model never reaches the network. */
  private resolveModel(options: AdapterInvokeOptions): string {
    const model = options.model ?? this.defaultModel;
    if (model) return model;
    throw new Error(
      'The Ollama adapter has no model to call: expected `model` in the call options, `model` in '
      + 'OllamaAdapterOptions, or the OLLAMA_MODEL environment variable, and none is set to a '
      + 'non-empty value. No request was sent.',
    );
  }

  private buildMessages(options: AdapterInvokeOptions): OllamaChatMessage[] {
    const msgs: OllamaChatMessage[] = [];
    if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt });
    msgs.push({ role: 'user', content: options.prompt });
    return msgs;
  }
}
