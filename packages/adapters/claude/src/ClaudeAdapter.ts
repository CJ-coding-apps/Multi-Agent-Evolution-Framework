import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, ToolCallRecord,
  TurnAdapter, TurnMessage, AssistantTurn, ModelSurface, ToolPlugin,
} from '@maf/types';
import { withModelSurface } from '@maf/types';
import { BaseAdapter } from '@maf/adapter-base';
import {
  spawnAndCollect, spawnStreaming, turnStdout,
  buildTurnSystemPrompt, serializeHistory, parseTurn, serializeTools,
  sha256Hex, elided, cliModelSurface,
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
 * needs only text and gets this set too, or `nativeTools: 'read-only'` (a role holding no write
 * tool, F7), which gets `CLAUDE_READ_ONLY_ISOLATION_ARGS` instead: the reading tools, and none
 * of the writing ones.
 */
const CLAUDE_TURN_ISOLATION_ARGS: readonly string[] = [
  '--tools', '',
  ...CLAUDE_MCP_ISOLATION_ARGS,
];

/**
 * The built-in tools a cli-tier reader keeps (F7): the ones that read the tree and nothing else.
 * `--tools` takes a comma-separated list — the same syntax as the `""` above, both taken from
 * `claude --help`: *"Specify the list of available tools from the built-in set. Use \"\" to
 * disable all tools, \"default\" to use all tools, or specify tool names (e.g. \"Bash,Edit,Read\")."*
 *
 * Without this a role that holds no write tool keeps claude's whole toolset — `Edit`, `Write` and
 * `Bash` among it — because on the cli tier MAF hands over one prompt and never sends the role's
 * allowlist. The role reads as read-only and is not: a live run had a read-only `reviewer` edit a
 * tracked file and maf report `Succeeded` having attested nothing. MAF still diffs the turn
 * (`unexpected_change`), but a change that cannot be made needs no catching.
 *
 * Deliberately short. `Read`, `Glob` and `Grep` are what reviewing a tree needs; anything that can
 * write, run a command, or reach the network is out of reach of a role that was not given the
 * authority to use it, and a reader that wants more is a role whose allowlist should say so.
 */
const CLAUDE_READ_ONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/** A cli-tier reader's turn: the read-only built-in set, MCP still isolated to empty. */
const CLAUDE_READ_ONLY_ISOLATION_ARGS: readonly string[] = [
  '--tools', CLAUDE_READ_ONLY_TOOLS.join(','),
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
    const args = this.buildArgs({
      ...opts,
      prompt: serializeHistory(history),
      systemPrompt,
    }, CLAUDE_TURN_ISOLATION_ARGS);
    // The surface is assembled where the call is (F4): the sha is of the exact bytes the system
    // block held and the argv is the one this turn spawns with — so a reader can settle what the
    // model was shown without re-deriving either. Built before the spawn, and attached to the
    // error if the turn fails (R3-S1): the loop holds only the role prompt, and a record built
    // from *that* would name bytes claude was never sent — no protocol, no catalogue, no argv.
    const surface = modelSurfaceOf(systemPrompt, opts.tools, args);
    try {
      const result = await this.spawn('claude', args, {
        cwd: opts.workingDir,
        timeoutMs: opts.timeoutMs,
        env: { ...process.env },
        ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      });
      // The turn fails in two places — the spawn rejects when the binary cannot run, and `turnStdout`
      // throws when it ran and did not finish cleanly — so both are inside the `try`: a record of a
      // failed turn is the one a reader most wants, and it must not depend on which way it failed.
      return { ...parseTurn(turnStdout(this.name, result)), modelSurface: surface };
    } catch (err: unknown) {
      throw attach(err, surface);
    }
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
    // The cli-tier call is a model call MAF made, so it belongs in the record (WP-3.0c): the same
    // evidence a governed turn reports, built from the argv this call spawned with — with the two
    // payload positionals elided, exactly as the governed turn's surface elides them, so the
    // record carries a digest of the prompt rather than the prompt. Built here, before the spawn,
    // so a binary that cannot start still carries what it was asked to run (R3-S1).
    const surface = cliModelSurface(options.systemPrompt, options.prompt, elidePayloads(args));

    const result = await this.spawn('claude', args, {
      cwd: options.workingDir,
      timeoutMs: options.timeoutMs,
      env: { ...process.env },
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
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
      modelSurface: { ...surface, outputSha256: sha256Hex(result.stdout) },
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

/**
 * What a cli-tier call is allowed of claude's own tools: the whole set by default, the read-only
 * set for a role that holds no write tool (`nativeTools: 'read-only'`, F7), and none at all when
 * the caller needs only text (`nativeTools: false`).
 */
function cliTierIsolation(options: AdapterInvokeOptions): readonly string[] {
  if (options.nativeTools === false) return CLAUDE_TURN_ISOLATION_ARGS;
  if (options.nativeTools === 'read-only') return CLAUDE_READ_ONLY_ISOLATION_ARGS;
  return CLAUDE_MCP_ISOLATION_ARGS;
}

/**
 * R3-S1: the surface of the call rides on whatever the call throws, so the loop records what claude
 * was actually sent. An error that is not an `Error` cannot carry a field; it is rethrown untouched
 * and the caller records its own fallback, marked as one.
 */
function attach(err: unknown, surface: ModelSurface): unknown {
  return err instanceof Error ? withModelSurface(err, surface) : err;
}

/** The governed turn's model-facing surface: the system block's digest, the catalogue, the argv. */
function modelSurfaceOf(systemPrompt: string, tools: ToolPlugin[] | undefined, argv: readonly string[]): ModelSurface {
  return {
    systemPromptSha256: sha256Hex(systemPrompt),
    toolCatalog:        serializeTools(tools),
    argv:               elidePayloads(argv),
  };
}

/**
 * The argv with its two payload positionals elided: the `--system-prompt` value and the trailing
 * prompt after `--`. Everything else — the flag names, `--tools`' empty string, the strict-MCP JSON
 * — is kept verbatim, because that is what the record is for: F4's open question was whether a flag
 * reached the binary, and a digest of the payload answers "what text" as well as the text would.
 * Matched by the token the value follows, over the argv this adapter just built.
 */
function elidePayloads(argv: readonly string[]): string[] {
  return argv.map((arg, i) => {
    if (argv[i - 1] === '--system-prompt') return elided('--system-prompt', arg);
    if (argv[i - 1] === '--' && i === argv.length - 1) return elided('prompt', arg);
    return arg;
  });
}
