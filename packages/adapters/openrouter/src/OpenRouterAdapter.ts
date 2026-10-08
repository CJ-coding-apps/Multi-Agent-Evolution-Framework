import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { TransportError } from '@maf/types';
import { BaseAdapter, failureTail } from '@maf/adapter-base';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/** OpenRouter attributes traffic to the app named by HTTP-Referer, so it must be this project. */
const MAF_REPOSITORY_URL = 'https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework';

interface OAIMessage  { role: 'system'|'user'|'assistant'; content: string }
interface OAIRequest  { model: string; messages: OAIMessage[]; stream: boolean; max_tokens?: number | undefined; temperature?: number | undefined }
interface OAIChoice   { message: OAIMessage; finish_reason: string }
interface OAIResponse { choices: OAIChoice[]; usage?: { total_tokens?: number } }
interface OAIStreamDelta { choices: Array<{ delta: { content?: string }; finish_reason?: string }> }

/** The request's own deadline, so an abort it caused is reported as the timeout it is. */
interface Deadline { signal: AbortSignal; ms: number }

/** undici reports every network failure as "fetch failed"; the reason is on its cause. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * `pending`, with every way of getting no answer — a refused or reset connection, a DNS failure, a
 * body cut off part-way, the request's own deadline — turned into a TransportError. None of them
 * says anything about the request, so the node may be retried on it (D-06).
 */
async function answered<T>(url: string, pending: Promise<T>, deadline?: Deadline): Promise<T> {
  try {
    return await pending;
  } catch (err) {
    const message = deadline !== undefined && deadline.signal.aborted
      ? `OpenRouter was expected to answer ${url} within ${deadline.ms} ms, but it had not, so the request was aborted.`
      : `OpenRouter was expected to answer ${url}, but the request failed before an answer arrived: ${describe(err)}`;
    throw new TransportError(message, { cause: err });
  }
}

/** A 5xx is the provider failing, not judging the request, so asking again can succeed (D-06). */
function serverFailure(url: string, status: number, body: string): TransportError {
  return new TransportError(
    `OpenRouter was expected to answer ${url}, but it failed with HTTP ${status}. Body tail: ${failureTail(body)}`,
  );
}

export interface OpenRouterAdapterOptions {
  apiKey?: string;
  model?:  string;
  baseUrl?: string;
  appName?: string;
  appUrl?:  string;
}

export class OpenRouterAdapter extends BaseAdapter {
  readonly name = 'openrouter' as const;
  private readonly apiKey:  string;
  private readonly defaultModel: string | undefined;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(opts: OpenRouterAdapterOptions = {}) {
    super();
    this.apiKey       = opts.apiKey   ?? process.env['OPENROUTER_API_KEY'] ?? '';
    // No fallback id: a pinned default goes stale and bills a model nobody chose. A missing
    // model is refused at the first call, not here, so the adapter can still be listed.
    this.defaultModel = opts.model    ?? process.env['OPENROUTER_MODEL'];
    this.baseUrl      = opts.baseUrl  ?? OPENROUTER_BASE;
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type':  'application/json',
      'HTTP-Referer':  opts.appUrl  ?? MAF_REPOSITORY_URL,
      'X-Title':       opts.appName ?? 'MAF',
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   false,
      inProcessLoop:       false,
      maxConcurrentTasks:  8,
      nativePlugins:       [],
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch { return false; }
  }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const start = Date.now();
    const body: OAIRequest = {
      model:       this.resolveModel(options),
      messages:    this.buildMessages(options),
      stream:      false,
      max_tokens:  options.tokenBudget,
      temperature: options.temperature,   // honored (golden determinism when pinned to 0)
    };

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const deadline: Deadline = { signal: controller.signal, ms: options.timeoutMs };
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await answered(url, fetch(url, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(body),
        signal:  controller.signal,
      }), deadline);
      const text = await answered(url, res.text(), deadline);
      if (res.status >= 500) throw serverFailure(url, res.status, text);
      if (!res.ok) {
        // A 4xx is the provider judging the request. Which of those are auth or quota is D-05's
        // classification (0.4.0); until then it is a failed result, not a retry.
        return { success: false, output: text, toolCallLog: [], exitCode: res.status, duration: Date.now() - start };
      }
      const data = JSON.parse(text) as OAIResponse;
      const content    = data.choices[0]?.message.content ?? '';
      const tokensUsed = data.usage?.total_tokens;
      return {
        success:     true,
        output:      content,
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        toolCallLog: [] as ToolCallRecord[],
        exitCode:    0,
        duration:    Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  override async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const body: OAIRequest = {
      model:       this.resolveModel(options),
      messages:    this.buildMessages(options),
      stream:      true,
      temperature: options.temperature,
    };
    const url = `${this.baseUrl}/chat/completions`;
    const res = await answered(url, fetch(url, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
    }));
    if (res.status >= 500) throw serverFailure(url, res.status, await answered(url, res.text()));
    if (!res.ok || !res.body) throw new Error(`OpenRouter stream error: ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await answered(url, reader.read());
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as OAIStreamDelta;
          const content = chunk.choices[0]?.delta.content;
          if (content) yield content;
        } catch { /* skip */ }
      }
    }
  }

  /** Runs before the request body exists, so a call with no model never reaches the network. */
  private resolveModel(options: AdapterInvokeOptions): string {
    const model = options.model ?? this.defaultModel;
    if (model) return model;
    throw new Error(
      'The OpenRouter adapter has no model to call: expected `model` in the call options, `model` in '
      + 'OpenRouterAdapterOptions, or the OPENROUTER_MODEL environment variable, and none is set to a '
      + 'non-empty value. No request was sent.',
    );
  }

  private buildMessages(options: AdapterInvokeOptions): OAIMessage[] {
    const msgs: OAIMessage[] = [];
    if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt });
    msgs.push({ role: 'user', content: options.prompt });
    return msgs;
  }
}
