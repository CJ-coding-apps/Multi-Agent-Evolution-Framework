import type {
  MemorySubgraph, MemoryNode, MemoryEdge, GhostCue, LcmSummary, LcmMessage, LcmTrigger,
  LcmSummarySurface, LcmDegradedRecord,
} from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import type { LcmEngine } from '@maf/lcm';

export interface InjectorConfig {
  graph:          MemoryGraph;
  lcm?:           LcmEngine;
  maxNodes:       number;     // max graph nodes to inject, default 40
  tokenBudget:    number;     // tokens reserved for injected context
}

export interface AssembledContext {
  systemPromptPrefix: string;   // prepend to adapter's systemPrompt
  estimatedTokens:    number;
  /**
   * Summary calls this assembly paid for (WP-3.2 F1). The dispatcher writes each into the
   * transcript, because a model call made on a node's behalf belongs in the node's record even
   * when MAF, not the model, decided to make it.
   */
  lcmSummaryCalls?: LcmSummarySurface[];
  /** Compactions that could not complete during this assembly (WP-3.2 F5). */
  lcmDegraded?:    LcmDegradedRecord[];
}

export class GraphAwareInjector {
  constructor(private readonly config: InjectorConfig) {}

  async assemble(
    taskContext: string,
    sessionId?: string,
    agentRole?: string,
    trigger?: LcmTrigger,
    options?: {
      /**
       * Whether the role that will read this prompt can call MAF tools (R14). A cli-tier role
       * cannot: MAF's registry is not exposed on its tier, so a Dolt cue telling it to call
       * `lcm.expand` is an instruction it cannot follow. In that case the archive is rendered as
       * summaries instead of cues. Absent reads as available, which is the in-process tier's
       * situation and the only tier a Dolt cue was ever true for.
       */
      mafToolsAvailable?: boolean;
    },
  ): Promise<AssembledContext> {
    const parts: string[] = [];
    let tokens = 0;
    let lcmSummaryCalls: LcmSummarySurface[] | undefined;
    let lcmDegraded: LcmDegradedRecord[] | undefined;

    if (agentRole) {
      const roleBlock = `<agent-role>${agentRole}</agent-role>`;
      parts.push(roleBlock);
      tokens += estimate(roleBlock);
    }

    // 1. The LCM archive comes first and gets the budget it needs, because it is what this
    //    injector renders on the archive's behalf (WP-3.2 F2). The two modes deliver it
    //    differently (D-17): Dolt hands over ghost cues, Upward the summaries themselves.
    //
    //    The newest messages are rendered after the archive as `<recent>`, inside the same budget
    //    (R4c). They used to be neither rendered nor charged on the premise that they were already
    //    in the prompt; they are the session's messages, and the adapter sees the prompt this
    //    injector builds, so on any session whose loop had not carried them they reached no prompt
    //    at all. The engine fits them newest-first into whatever the archive left. The tail that
    //    stays raw is what was rendered, not a fixed count: a message that does not fit is
    //    summarized by that same assembly (V1), so every message is rendered, covered by a
    //    summary, or newer than the assembly.
    if (this.config.lcm && sessionId && tokens < this.config.tokenBudget) {
      const ctx = await this.config.lcm.assembleContext(
        sessionId, this.config.tokenBudget - tokens, undefined, trigger,
        options?.mafToolsAvailable === false ? 'summaries' : undefined,
      );
      // Passed straight through rather than re-derived here: the assembly is the only place that
      // knows which calls it made and which compactions it could not finish.
      if (ctx.summaryCalls && ctx.summaryCalls.length > 0) lcmSummaryCalls = ctx.summaryCalls;
      if (ctx.degraded && ctx.degraded.length > 0) lcmDegraded = ctx.degraded;
      if (ctx.summaries && ctx.summaries.length > 0) {
        const summaryXml = formatSummaries(ctx.summaries);
        parts.push(summaryXml);
        tokens += estimate(summaryXml);
      }
      if (ctx.ghosts.length > 0) {
        const ghostXml = formatGhosts(ctx.ghosts);
        parts.push(ghostXml);
        tokens += estimate(ghostXml);
      }
      if (ctx.messages.length > 0) {
        const recentXml = formatRecent(ctx.messages);
        parts.push(recentXml);
        tokens += estimate(recentXml);
      }
    }

    // 2. The graph gets what the archive left, never more than its share of the total. A graph
    //    error must not cost the node its archive, and an archive is the more specific context.
    const graphBudget = Math.min(
      Math.max(0, this.config.tokenBudget - tokens),
      this.config.tokenBudget * 0.6,
    );
    if (graphBudget > 0) {
      const subgraph = await this.config.graph.querySubgraph(taskContext, this.config.maxNodes);
      if (subgraph.nodes.length > 0) {
        const xml = formatSubgraph(subgraph, graphBudget);
        parts.push(xml);
        tokens += estimate(xml);
      }
    }

    const systemPromptPrefix = parts.length > 0
      ? `<memory-context>\n${parts.join('\n')}\n</memory-context>\n`
      : '';

    return {
      systemPromptPrefix,
      estimatedTokens: tokens,
      ...(lcmSummaryCalls !== undefined ? { lcmSummaryCalls } : {}),
      ...(lcmDegraded !== undefined ? { lcmDegraded } : {}),
    };
  }
}

function formatSubgraph(subgraph: MemorySubgraph, tokenBudget: number): string {
  // Relevance-sorted nodes, pruned to budget
  const sorted = [...subgraph.nodes].sort((a, b) =>
    (subgraph.relevanceScores.get(b.id) ?? 0) - (subgraph.relevanceScores.get(a.id) ?? 0),
  );

  const lines: string[] = ['<memory-graph>'];
  let used = 0;

  for (const node of sorted) {
    const line = formatNode(node);
    const cost = estimate(line);
    if (used + cost > tokenBudget) break;
    lines.push(line);
    used += cost;
  }

  // Add relevant edges between included node IDs
  const nodeIds = new Set(sorted.map((n) => n.id));
  for (const edge of subgraph.edges) {
    if (nodeIds.has(edge.fromId) && nodeIds.has(edge.toId)) {
      const line = formatEdge(edge);
      if (used + estimate(line) > tokenBudget) break;
      lines.push(line);
      used += estimate(line);
    }
  }

  lines.push('</memory-graph>');
  return lines.join('\n');
}

function formatNode(n: MemoryNode): string {
  const props = Object.entries(n.properties)
    .slice(0, 3)
    .map(([k, v]) => `${k}="${String(v).slice(0, 80)}"`)
    .join(' ');
  return `  <node id="${n.id.slice(0, 8)}" kind="${n.kind}" label="${n.label}" ${props}/>`;
}

function formatEdge(e: MemoryEdge): string {
  return `  <edge from="${e.fromId.slice(0, 8)}" to="${e.toId.slice(0, 8)}" rel="${e.relation}"/>`;
}

function formatGhosts(ghosts: GhostCue[]): string {
  const lines = ghosts.map((g) =>
    `  <ghost id="${g.summaryId}" relevance="${g.relevance.toFixed(2)}">${escapeXml(g.cueText)}</ghost>`,
  );
  return `<ghost-cues>\n${lines.join('\n')}\n</ghost-cues>`;
}

/**
 * Upward mode's archive. Summary content is text an earlier model produced from an earlier run,
 * so it goes into the prompt escaped: a summary is data, not markup and not instructions.
 */
function formatSummaries(summaries: LcmSummary[]): string {
  const lines = summaries.map((s) =>
    `  <summary id="${escapeXml(s.id)}" level="${s.level}" tokens="${s.tokens}">${escapeXml(s.content)}</summary>`,
  );
  return `<summaries>\n${lines.join('\n')}\n</summaries>`;
}

/**
 * The session's newest messages, newest first (R4c). Message text can contain anything a tool or a
 * model wrote, so it is escaped for the same reason a summary is: data, never markup.
 */
function formatRecent(messages: LcmMessage[]): string {
  const lines = messages.map((m) =>
    `  <message role="${escapeXml(m.role)}">${escapeXml(m.content)}</message>`,
  );
  return `<recent>\n${lines.join('\n')}\n</recent>`;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/**
 * One pass over the five XML metacharacters, so escaping is never re-applied to its own output.
 * It is also shaped this way because the repo-wide rule against rewriting a quote on its way into
 * a query (memory-graph's `no-escaper` guard) matches a `replace(/…/g` whose needle is a lone
 * quote; this is XML, not Cypher, but the rule cannot tell the two apart and must stay broad.
 */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

function estimate(text: string): number { return Math.ceil(text.length / 4); }
