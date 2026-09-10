import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { BaseAdapter, spawnAndCollect, spawnStreaming } from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex' as const;

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   true,
      maxConcurrentTasks:  4,
      nativePlugins:       [],
    };
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
