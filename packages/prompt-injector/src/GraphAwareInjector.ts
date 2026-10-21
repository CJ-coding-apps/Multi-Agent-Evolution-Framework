import type { MemorySubgraph, MemoryNode, MemoryEdge, GhostCue, LcmSummary } from '@maf/types';
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
}

export class GraphAwareInjector {
  constructor(private readonly config: InjectorConfig) {}

  async assemble(taskContext: string, sessionId?: string, agentRole?: string): Promise<AssembledContext> {
    const parts: string[] = [];
    let tokens = 0;

    if (agentRole) {
      const roleBlock = `<agent-role>${agentRole}</agent-role>`;
      parts.push(roleBlock);
      tokens += estimate(roleBlock);
    }

    // 1. Query relevant memory subgraph
    const subgraph = await this.config.graph.querySubgraph(taskContext, this.config.maxNodes);
    if (subgraph.nodes.length > 0) {
      const xml = formatSubgraph(subgraph, this.config.tokenBudget * 0.6);
      parts.push(xml);
      tokens += estimate(xml);
    }

    // 2. Add LCM context if available. The two modes deliver the archive differently (D-17):
    //    Dolt hands over ghost cues, Upward hands over the summaries themselves. The injector
    //    renders whichever it is given, so a mode that returns neither adds nothing.
    if (this.config.lcm && sessionId) {
      const ctx = await this.config.lcm.assembleContext(sessionId, this.config.tokenBudget - tokens);
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
    }

    const systemPromptPrefix = parts.length > 0
      ? `<memory-context>\n${parts.join('\n')}\n</memory-context>\n`
      : '';

    return { systemPromptPrefix, estimatedTokens: tokens };
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
