import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { makeToolId, redactCredentials } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';

/**
 * What an expanded summary looks like to the tool. Deliberately structural, not an import of
 * `@maf/lcm`: the tools package must not depend on the memory package, and the CLI already holds
 * both and can hand this in.
 */
export interface LcmExpandedSummary {
  content: string;
  level: number;
}

export interface LcmExpandedMessage {
  role:    string;
  content: string;
}

export interface LcmExpansion {
  summary:  LcmExpandedSummary;
  messages: LcmExpandedMessage[];
}

/** Resolves one summary id, or `undefined` when no such summary exists. */
export type LcmExpander = (summaryId: string) => Promise<LcmExpansion | undefined>;

interface LcmExpandInput {
  summaryId: string;
  [k: string]: unknown;
}

/**
 * `lcm.expand` (WP-3.2 F8). Dolt mode's ghost cue tells the model to call this tool by name, so
 * the name has to exist in every role's registry and it has to return what the cue promises: the
 * summary text and the messages it covers.
 *
 * Read-only and pathless: it reads the run's own archive, not the tree. Both halves are masked on
 * the way out (F7) — a summary and its sources are model text from earlier turns, and the tool
 * result is a model-text path like any other.
 */
export class LcmExpandTool extends BaseTool<LcmExpandInput> {
  readonly id: ToolId = makeToolId('lcm.expand');
  readonly name = 'lcm.expand';
  readonly description =
    'Expand a context summary by id. Returns the summary text and the messages it covers. ' +
    'Use this when a <ghost> cue names a summary id.';
  readonly permissionLevel = 'read' as const;
  readonly inputSchema = closedInput({
    summaryId: { type: 'string', description: 'the summary id named by a ghost cue' },
  }, ['summaryId']);

  /**
   * `expand` is absent only in a registry that exists to validate role allowlists (the harness is
   * minted before the run opens its store). The tool is still registered there, because a role set
   * that names it must validate; it refuses with a truthful reason rather than pretending every id
   * is unknown.
   */
  constructor(private readonly expand: LcmExpander | undefined) { super(); }

  /** No filesystem surface: the archive is the run's own store. */
  declaredPaths(): string[] { return []; }

  async execute(input: LcmExpandInput, _ctx: ToolContext): Promise<ToolResult> {
    const started = performance.now();
    const unusable = this.unusable(input, started);
    if (unusable) return unusable;

    const summaryId = input.summaryId.trim();
    if (summaryId === '') return this.failed(new Error('summaryId is empty'), started);
    if (!this.expand) {
      return this.err(
        'lcm.expand: this run has no context archive (LCM is not configured), so no summary can be expanded.',
        performance.now() - started,
      );
    }

    const expansion = await this.expand(summaryId);
    if (!expansion) {
      return this.err(
        `lcm.expand: no summary "${summaryId}". A ghost cue names a summary in this run's archive; ` +
        `an id from another run cannot be expanded here.`,
        performance.now() - started,
      );
    }

    const lines = [
      `<summary id="${summaryId}" level="${expansion.summary.level}">`,
      redactCredentials(expansion.summary.content),
      '</summary>',
      `<source-messages count="${expansion.messages.length}">`,
      ...expansion.messages.map((message) =>
        `[${message.role.toUpperCase()}] ${redactCredentials(message.content)}`),
      '</source-messages>',
    ];
    return this.ok(lines.join('\n'), performance.now() - started, {
      summaryId,
      level: expansion.summary.level,
      messages: expansion.messages.length,
    });
  }
}
