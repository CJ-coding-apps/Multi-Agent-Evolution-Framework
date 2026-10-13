import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord } from '@maf/types';
import { BaseAdapter, spawnAndCollect, spawnStreaming } from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

/**
 * MCP isolation for every `gemini` spawn. The Gemini CLI has no "ignore every configured server"
 * switch; it has an allowlist, `--allowed-mcp-server-names`, which replaces the `mcp.allowed`
 * setting ("only servers from this list will be connected to"). An empty list is not a refusal —
 * the CLI keeps an empty array as the allowlist, and what its core makes of one is not
 * documented — so the list names one server that no configuration defines. Unverified against a
 * live binary in this release: if a Gemini version rejects the flag, every gemini call fails on
 * it, and this constant is the one place to change.
 */
const GEMINI_MCP_ISOLATION_ARGS: readonly string[] = [
  '--allowed-mcp-server-names', 'maf-allows-no-mcp-server',
];

/**
 * The functions the adapter runs the `gemini` binary through. Injectable so a test can stand in
 * for the binary and its failures; production uses the real spawner.
 */
export interface GeminiAdapterOptions {
  spawn?:          typeof spawnAndCollect;
  spawnStreaming?: typeof spawnStreaming;
}

export class GeminiAdapter extends BaseAdapter {
  readonly name = 'gemini' as const;
  private readonly spawn:          typeof spawnAndCollect;
  private readonly spawnStreaming: typeof spawnStreaming;

  constructor(opts: GeminiAdapterOptions = {}) {
    super();
    this.spawn          = opts.spawn          ?? spawnAndCollect;
    this.spawnStreaming = opts.spawnStreaming ?? spawnStreaming;
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming:    true,
      supportsToolCalling: true,
      supportsWorktrees:   false,
      inProcessLoop:       false,
      maxConcurrentTasks:  2,
      nativePlugins:       [],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('gemini', ['--version']);
      return true;
    } catch { return false; }
  }

  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const start = Date.now();
    const args = this.buildArgs(options);
    const result = await this.spawn('gemini', args, {
      cwd: options.workingDir,
      timeoutMs: options.timeoutMs,
      env: { ...process.env },
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
    const args = this.buildArgs(options);
    for await (const chunk of this.spawnStreaming('gemini', args, { cwd: options.workingDir })) {
      yield chunk;
    }
  }

  private buildArgs(options: AdapterInvokeOptions): string[] {
    const args: string[] = [];
    if (options.model) args.push('--model', options.model);
    if (options.systemPrompt) args.push('--system-instruction', options.systemPrompt);
    args.push(...GEMINI_MCP_ISOLATION_ARGS);
    // nativeTools: false — no Gemini CLI flag is known to withhold its built-in tools, so none is passed.
    //
    // The prompt is the value of `--prompt`, not a positional: a positional query runs interactively
    // in a terminal, and `--prompt` is the non-interactive mode. Joined with `=` so yargs takes it as
    // the value whatever it starts with. As a separate argument after `-p`, a prompt beginning with
    // `-` is not taken as its value — `-p` has `nargs: 1`, which stops at a dash argument — and is
    // parsed as options instead; a `--` there would leave `-p` with no value at all.
    args.push(`--prompt=${options.prompt}`);
    return args;
  }
}
