import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord,
  TurnAdapter, TurnMessage, AssistantTurn,
} from '@maf/types';
import {
  BaseAdapter, spawnAndCollect, spawnStreaming,
  buildTurnSystemPrompt, serializeHistory, parseTurn,
} from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

export class CodexAdapter extends BaseAdapter implements TurnAdapter {
  readonly name = 'codex' as const;

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   true,
      // Kept FALSE deliberately: `sendTurn` below drives tools through MAF's
      // gate, but Codex's autonomous mode (--full-auto) would ALSO run tools,
      // bypassing the gate. The RoleDispatcher gate requires BOTH sendTurn and
      // this flag, so Codex stays on the CLI path until a non-autonomous Codex
      // invocation is verified against a live binary — then flip to true.
      inProcessLoop:       false,
      maxConcurrentTasks:  4,
      nativePlugins:       [],
    };
  }

  /**
   * Turn-level model access using the shared MAF wire protocol. Codex has no
   * `--system-prompt` flag, so the system block (role prompt + protocol + tool
   * catalog) is prepended to the serialized history on stdin. Intentionally does
   * NOT pass --full-auto: on this path MAF drives tool execution, not Codex.
   */
  async sendTurn(history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    const systemBlock = buildTurnSystemPrompt(opts.systemPrompt, opts.tools);
    const input = `${systemBlock}\n\n${serializeHistory(history)}`;
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    const result = await spawnAndCollect('codex', args, {
      cwd:       opts.workingDir,
      timeoutMs: opts.timeoutMs,
      input,
      env:       { ...process.env },
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    });
    return parseTurn(result.stdout);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('codex', ['--version']);
      return true;
    } catch { return false; }
  }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const start = Date.now();
    // Codex CLI takes prompt via stdin with optional flags
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.prompt}`
      : options.prompt;

    const args: string[] = ['--full-auto'];
    if (options.model) args.push('--model', options.model);

    const result = await spawnAndCollect('codex', args, {
      cwd:       options.workingDir,
      timeoutMs: options.timeoutMs,
      input:     fullPrompt,
      env:       { ...process.env },
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
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.prompt}`
      : options.prompt;
    const args: string[] = ['--full-auto', '--stream'];
    if (options.model) args.push('--model', options.model);
    const proc = spawnStreaming('codex', args, { cwd: options.workingDir });
    // Write stdin by injecting via process pipe — handled in spawnStreaming
    for await (const chunk of proc) yield chunk;
  }
}
