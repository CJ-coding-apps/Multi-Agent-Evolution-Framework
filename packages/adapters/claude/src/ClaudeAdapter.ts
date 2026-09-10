import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';
import { spawnAndCollect, spawnStreaming } from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

export class ClaudeAdapter extends BaseAdapter {
  readonly name = 'claude' as const;

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   true,
      maxConcurrentTasks:  4,
      nativePlugins:       ['mcp', 'superpowers'],
    };
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
    // Prompt goes last via stdin; claude CLI reads from stdin when --print is used
    args.push('-p', options.prompt);
    return args;
  }
}
