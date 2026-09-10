import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord,
  TurnAdapter, TurnMessage, AssistantTurn,
} from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';
import {
  spawnAndCollect, spawnStreaming,
  buildTurnSystemPrompt, serializeHistory, parseTurn,
} from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

export class ClaudeAdapter extends BaseAdapter implements TurnAdapter {
  readonly name = 'claude' as const;

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
    const result = await spawnAndCollect('claude', this.buildArgs({
      ...opts,
      prompt: serializeHistory(history),
      systemPrompt,
    }), {
      cwd: opts.workingDir,
      timeoutMs: opts.timeoutMs,
      env: { ...process.env },
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    });
    return parseTurn(result.stdout);
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

    const result = await spawnAndCollect('claude', args, {
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
    };
  }

  override async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const args = [...this.buildArgs(options), '--stream'];
    for await (const chunk of spawnStreaming('claude', args, { cwd: options.workingDir })) {
      yield chunk;
    }
  }

  private buildArgs(options: AdapterInvokeOptions): string[] {
    const args: string[] = ['--print'];
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
    if (options.model)        args.push('--model', options.model);
    if (options.tokenBudget)  args.push('--max-tokens', String(options.tokenBudget));
    // NOTE: the claude CLI has no temperature flag in --print mode, so
    // opts.temperature is intentionally ignored here (contract: adapters that
    // cannot pin temperature must ignore it, never error). Golden determinism on
    // the CLI path relies on the model default, not a pinned temperature.
    args.push('-p', options.prompt);
    return args;
  }
}
