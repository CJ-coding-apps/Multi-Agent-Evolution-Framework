import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord,
  TurnAdapter, TurnMessage, AssistantTurn, ModelSurface,
} from '@maf/types';
import { withModelSurface } from '@maf/types';
import {
  BaseAdapter, spawnAndCollect, spawnStreaming, turnStdout,
  buildTurnSystemPrompt, serializeHistory, parseTurn, cliModelSurface, sha256Hex,
} from '@maf/adapter-base';

const execFileAsync = promisify(execFile);

// MCP isolation: none. Codex loads every server under `[mcp_servers.*]` in ~/.codex/config.toml,
// and its CLI has no flag that ignores them. A `-c mcp_servers={}` override might, but whether a
// table override replaces or merges into the configured one is not verified, and an argument the
// binary rejects fails every call — so no flag is passed rather than one that may not work. The
// README must say so (WP-2.13): "With --adapter codex, the Codex CLI connects to every MCP server
// in your ~/.codex/config.toml; MAF cannot withhold them. Disable them there before a run."

/**
 * The functions the adapter runs the `codex` binary through. Injectable so a test can stand in
 * for the binary and its failures; production uses the real spawner.
 */
export interface CodexAdapterOptions {
  spawn?:          typeof spawnAndCollect;
  spawnStreaming?: typeof spawnStreaming;
}

export class CodexAdapter extends BaseAdapter implements TurnAdapter {
  readonly name = 'codex' as const;
  private readonly spawn:          typeof spawnAndCollect;
  private readonly spawnStreaming: typeof spawnStreaming;

  constructor(opts: CodexAdapterOptions = {}) {
    super();
    this.spawn          = opts.spawn          ?? spawnAndCollect;
    this.spawnStreaming = opts.spawnStreaming ?? spawnStreaming;
  }

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
      //
      // When that happens, the D-46 TOOL_PROTOCOL paragraph (which tells the model the host's own
      // tools are off) must be made true first: it assumes the turn runs with the backend's native
      // tools disabled, which claude does with `--tools ''` (D-33). No Codex flag is known to do the
      // same, so flipping this to true without finding one would spawn a turn whose prompt lies.
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
   *
   * Native tools: still on. D-33 has a governed turn spawn its backend with every built-in
   * tool off (Claude: `--tools ""`), but no Codex CLI flag is known to turn off its shell and
   * file tools, so none is passed — one more reason `inProcessLoop` stays false above.
   */
  async sendTurn(history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    const systemBlock = buildTurnSystemPrompt(opts.systemPrompt, opts.tools);
    const historyText = serializeHistory(history);
    const input = `${systemBlock}\n\n${historyText}`;
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    // R3-S1: composed before the spawn and attached to a throw, so a failed governed turn records
    // the system block this adapter built and the blob codex was written — the loop holds only the
    // role prompt and would otherwise name bytes codex was never sent.
    const surface = cliModelSurface(systemBlock, historyText, args, undefined, input);
    try {
      const result = await this.spawn('codex', args, {
        cwd:       opts.workingDir,
        timeoutMs: opts.timeoutMs,
        input,
        env:       { ...process.env },
        ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      });
      // Both ways a turn fails — the spawn rejects, or `turnStdout` throws on a run that did not
      // finish cleanly — are inside the `try`, so the error a failed turn throws always carries its
      // surface (R3-S1).
      return { ...parseTurn(turnStdout(this.name, result)), modelSurface: surface };
    } catch (err: unknown) {
      throw attach(err, surface);
    }
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

    // `--full-auto` is Codex's sandboxed automatic mode, on every cli-tier call: the planner's and the
    // reviewer's too. It is documented (README.md, docs/SECURITY.md) and named in the UNGOVERNED banner.
    // nativeTools: false — no Codex CLI flag is known to withhold its own tools, so none is passed.
    const args: string[] = ['--full-auto'];
    if (options.model) args.push('--model', options.model);

    // R3-S1: the call's surface is composed before the spawn, so a binary that cannot start still
    // carries what it was asked to run.
    const surface = cliModelSurface(options.systemPrompt, options.prompt, args, undefined, fullPrompt);
    const result = await this.spawn('codex', args, {
      cwd:       options.workingDir,
      timeoutMs: options.timeoutMs,
      input:     fullPrompt,
      env:       { ...process.env },
    }).catch((err: unknown): never => { throw attach(err, surface); });
    return {
      success:     result.exitCode === 0,
      output:      result.stdout,
      toolCallLog: [] as ToolCallRecord[],
      exitCode:    result.exitCode,
      duration:    this.elapsed(start),
      // Forwarded so the dispatcher can tell a timeout or a silent exit — retryable (D-06) —
      // from an answer that happens to be a failure.
      ...(result.transportError !== undefined ? { transportError: result.transportError } : {}),
      // The cli-tier call's model-facing surface (WP-3.0c). The argv has no payload positional — the
      // binary takes the prompt on stdin — so it is carried verbatim; the prompt digest is of what
      // was composed and `stdinSha256` of the blob codex was actually written, which joins the
      // system block and the prompt (F7): the two parts do not by themselves say what was sent.
      modelSurface: { ...surface, outputSha256: sha256Hex(result.stdout) },
    };
  }

  override async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.prompt}`
      : options.prompt;
    const args: string[] = ['--full-auto', '--stream'];
    if (options.model) args.push('--model', options.model);
    const proc = this.spawnStreaming('codex', args, { cwd: options.workingDir });
    // Write stdin by injecting via process pipe — handled in spawnStreaming
    for await (const chunk of proc) yield chunk;
  }
}

/**
 * R3-S1: the surface of the call rides on whatever the call throws, so a failed turn records what
 * codex was actually sent. A value that is not an `Error` cannot carry a field; it is rethrown
 * untouched and the caller records its own fallback, marked as one.
 */
function attach(err: unknown, surface: ModelSurface): unknown {
  return err instanceof Error ? withModelSurface(err, surface) : err;
}
