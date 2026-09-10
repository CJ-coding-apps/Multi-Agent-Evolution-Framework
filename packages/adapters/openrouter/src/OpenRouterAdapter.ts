import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

interface OAIMessage  { role: 'system'|'user'|'assistant'; content: string }
interface OAIRequest  { model: string; messages: OAIMessage[]; stream: boolean; max_tokens?: number | undefined; temperature?: number | undefined }
interface OAIChoice   { message: OAIMessage; finish_reason: string }
interface OAIResponse { choices: OAIChoice[]; usage?: { total_tokens?: number } }
interface OAIStreamDelta { choices: Array<{ delta: { content?: string }; finish_reason?: string }> }

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
  private readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(opts: OpenRouterAdapterOptions = {}) {
    super();
    this.apiKey       = opts.apiKey   ?? process.env['OPENROUTER_API_KEY'] ?? '';
    this.defaultModel = opts.model    ?? process.env['OPENROUTER_MODEL']   ?? 'anthropic/claude-sonnet-4-6';
    this.baseUrl      = opts.baseUrl  ?? OPENROUTER_BASE;
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type':  'application/json',
      'HTTP-Referer':  opts.appUrl  ?? 'https://github.com/maf',
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
      model:       options.model ?? this.defaultModel,
      messages:    this.buildMessages(options),
      stream:      false,
      max_tokens:  options.tokenBudget,
      temperature: options.temperature,   // honored (golden determinism when pinned to 0)
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, output: text, toolCallLog: [], exitCode: res.status, duration: Date.now() - start };
      }
      const data = await res.json() as OAIResponse;
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
      model:       options.model ?? this.defaultModel,
      messages:    this.buildMessages(options),
      stream:      true,
      temperature: options.temperature,
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`OpenRouter stream error: ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
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

  private buildMessages(options: AdapterInvokeOptions): OAIMessage[] {
    const msgs: OAIMessage[] = [];
    if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt });
    msgs.push({ role: 'user', content: options.prompt });
    return msgs;
  }
}
