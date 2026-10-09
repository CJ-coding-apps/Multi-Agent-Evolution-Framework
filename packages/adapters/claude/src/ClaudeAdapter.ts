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
 * MCP isolation for every `claude` spawn: `--strict-mcp-config` ("only use MCP servers from
 * --mcp-config, ignoring all other MCP configurations") with `--mcp-config` naming an empty server
 * set, so a backend MAF spawns gets no MCP server MAF did not hand it — none from the user's or
 * the project's configuration. Flag names as the Claude Code CLI reference documents them
 * (code.claude.com/docs/en/cli-reference); they are kept here, in one place, so a CLI that
 * renames them is fixed in one line. The JSON is one argv element, and `--mcp-config` takes
 * several values, so it must be followed by another option, never by the positional prompt.
 */
const CLAUDE_MCP_ISOLATION_ARGS: readonly string[] = [
  '--strict-mcp-config',
  '--mcp-config', JSON.stringify({ mcpServers: {} }),
];

/**
 * Isolation for a governed turn (`sendTurn`, the in-process tier): the MCP isolation above plus
 * `--tools ""` ("restrict which built-in tools Claude can use. Use `""` to disable all"), so the
 * spawned `claude` has no native tool of its own (D-33). In the governed loop MAF is the only
 * thing that runs a tool: the model asks in the wire protocol and each call goes through the
 * policy gate, the processors and the attestor. A backend with its own Read, Edit or Bash would
 * act inside a single turn, before its answer reaches MAF — and edit files outside policy and
 * attestation wherever the user's `permissions.allow` lets it. `--tools` leaves MCP tools alone;
 * the empty strict MCP set removes those, and with none left `""` removes every built-in tool.
 * The empty string is one argv element (`spawn` runs without a shell). `invoke` and `stream`
 * are the cli tier, where the backend is meant to act with its own tools, so they keep them —
 * unless the caller says `nativeTools: false` (the planner, the security reviewer), whose call
 * needs only text and gets this set too.
 */
const CLAUDE_TURN_ISOLATION_ARGS: readonly string[] = [
  '--tools', '',
  ...CLAUDE_MCP_ISOLATION_ARGS,
];

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
    }, CLAUDE_TURN_ISOLATION_ARGS), {
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
    const args = this.buildArgs(options, cliTierIsolation(options));

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
    const args = this.buildArgs(options, [...cliTierIsolation(options), '--stream']);
    for await (const chunk of this.spawnStreaming('claude', args, { cwd: options.workingDir })) {
      yield chunk;
    }
  }

  private buildArgs(options: AdapterInvokeOptions, isolation: readonly string[]): string[] {
    const args: string[] = ['--print'];
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
    if (options.model)        args.push('--model', options.model);
    // NOTE: the claude CLI has neither a token-cap nor a temperature flag in --print mode
    // (`claude --help | grep -c max-tokens` → 0; passing `--max-tokens` made every node of a
    // role with a tokenBudget exit 1 on "unknown option"), so opts.tokenBudget and
    // opts.temperature are intentionally ignored here (contract: adapters that cannot honour
    // a knob must ignore it, never error). The in-process loop enforces tokenBudget itself;
    // golden determinism on the CLI path relies on the model default, not a pinned temperature.
    args.push(...isolation);
    // `--` ends option parsing, so the prompt is the positional prompt whatever it starts with: a
    // node description beginning `--settings=…` would otherwise be read as that option.
    args.push('-p', '--', options.prompt);
    return args;
  }
}

/** A cli-tier call keeps claude's own tools unless its caller needs only text (`nativeTools: false`). */
function cliTierIsolation(options: AdapterInvokeOptions): readonly string[] {
  return options.nativeTools === false ? CLAUDE_TURN_ISOLATION_ARGS : CLAUDE_MCP_ISOLATION_ARGS;
}
