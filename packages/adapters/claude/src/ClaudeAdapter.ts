import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord,
  TurnAdapter, TurnMessage, AssistantTurn,
} from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';
import {
  spawnAndCollect, spawnStreaming, turnStdout,
  buildTurnSystemPrompt, serializeHistory, parseTurn,
} from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

/**
 * The functions the adapter runs the `claude` binary through. Injectable so a test can stand in
 * for the binary and its failures; production uses the real spawner.
 */
export interface ClaudeAdapterOptions {
  spawn?:          typeof spawnAndCollect;
  spawnStreaming?: typeof spawnStreaming;
}

export class ClaudeAdapter extends BaseAdapter implements TurnAdapter {
  readonly name = 'claude' as const;
  private readonly spawn:          typeof spawnAndCollect;
  private readonly spawnStreaming: typeof spawnStreaming;

  constructor(opts: ClaudeAdapterOptions = {}) {
    super();
    this.spawn          = opts.spawn          ?? spawnAndCollect;
    this.spawnStreaming = opts.spawnStreaming ?? spawnStreaming;
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   true,
      inProcessLoop:       true,
      maxConcurrentTasks:  4,
      nativePlugins:       ['mcp', 'superpowers'],
    };
  }

  async sendTurn(history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    // System block = role prompt + wire protocol + the allowlisted tool catalog
    // (by id — the loop resolves calls by tool id). Without the catalog the model
    // is blind to which tools exist.
    const systemPrompt = buildTurnSystemPrompt(opts.systemPrompt, opts.tools);
    const result = await this.spawn('claude', this.buildArgs({
      ...opts,
      prompt: serializeHistory(history),
      systemPrompt,
    }), {
      cwd: opts.workingDir,
      timeoutMs: opts.timeoutMs,
      env: { ...process.env },
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    });
    return parseTurn(turnStdout(this.name, result));
  }


  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('claude', ['--version']);
      return true;
    } catch { return false; }
  }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const start = Date.now();
    const args = this.buildArgs(options);

    const result = await this.spawn('claude', args, {
      cwd: options.workingDir,
      timeoutMs: options.timeoutMs,
      env: { ...process.env },
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });

    return {
      success:     result.exitCode === 0,
      output:      result.stdout,
      toolCallLog: [] as ToolCallRecord[],
      exitCode:    result.exitCode,
      duration:    this.elapsed(start),
      // Forwarded so the dispatcher can tell a timeout or a silent exit — retryable (D-06) —
      // from an answer that happens to be a failure.
      ...(result.transportError !== undefined ? { transportError: result.transportError } : {}),
    };
  }

  override async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const args = [...this.buildArgs(options), '--stream'];
    for await (const chunk of this.spawnStreaming('claude', args, { cwd: options.workingDir })) {
      yield chunk;
    }
  }

  private buildArgs(options: AdapterInvokeOptions): string[] {
    const args: string[] = ['--print'];
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
    if (options.model)        args.push('--model', options.model);
    // NOTE: the claude CLI has neither a token-cap nor a temperature flag in --print mode
    // (`claude --help | grep -c max-tokens` → 0; passing `--max-tokens` made every node of a
    // role with a tokenBudget exit 1 on "unknown option"), so opts.tokenBudget and
    // opts.temperature are intentionally ignored here (contract: adapters that cannot honour
    // a knob must ignore it, never error). The in-process loop enforces tokenBudget itself;
    // golden determinism on the CLI path relies on the model default, not a pinned temperature.
    args.push('-p', options.prompt);
    return args;
  }
}
