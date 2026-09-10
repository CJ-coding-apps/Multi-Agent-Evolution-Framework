import type { MemorySubgraph, MemoryNode, MemoryEdge, GhostCue } from '@maf/types';
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

    // 2. Add ghost cues from LCM if available
    if (this.config.lcm && sessionId) {
      const ctx = await this.config.lcm.assembleContext(sessionId, this.config.tokenBudget - tokens);
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
    `  <ghost id="${g.summaryId}" relevance="${g.relevance.toFixed(2)}">${g.cueText}</ghost>`,
  );
  return `<ghost-cues>\n${lines.join('\n')}\n</ghost-cues>`;
}

function estimate(text: string): number { return Math.ceil(text.length / 4); }
