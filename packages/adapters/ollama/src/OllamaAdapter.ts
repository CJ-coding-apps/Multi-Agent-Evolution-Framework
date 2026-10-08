import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, output: text, toolCallLog: [], exitCode: res.status, duration: Date.now() - start };
      }
      const data = await res.json() as OllamaResponse;
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

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok || !res.body) throw new Error(`Ollama stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
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
