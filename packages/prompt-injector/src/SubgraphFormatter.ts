import type { MemorySubgraph, MemoryNode, MemoryEdge } from '@maf/types';

export type FormatMode = 'xml' | 'markdown';

export class SubgraphFormatter {
  constructor(private readonly mode: FormatMode = 'xml') {}

  format(subgraph: MemorySubgraph, tokenBudget: number): string {
    return this.mode === 'xml'
      ? this.formatXml(subgraph, tokenBudget)
      : this.formatMarkdown(subgraph, tokenBudget);
  }

  private formatXml(subgraph: MemorySubgraph, tokenBudget: number): string {
    const sorted = sortByRelevance(subgraph);
    const lines: string[] = ['<memory-graph>'];
    let used = 0;

    for (const node of sorted) {
      const line = nodeToXml(node);
      const cost = estimate(line);
      if (used + cost > tokenBudget) break;
      lines.push(line);
      used += cost;
    }

    const includedIds = new Set(sorted.map((n) => n.id));
    for (const edge of subgraph.edges) {
      if (!includedIds.has(edge.fromId) || !includedIds.has(edge.toId)) continue;
      const line = edgeToXml(edge);
      if (used + estimate(line) > tokenBudget) break;
      lines.push(line);
      used += estimate(line);
    }

    lines.push('</memory-graph>');
    return lines.join('\n');
  }

  private formatMarkdown(subgraph: MemorySubgraph, tokenBudget: number): string {
    const sorted = sortByRelevance(subgraph);
    const lines: string[] = ['## Memory Graph', ''];
    let used = 0;

    for (const node of sorted) {
      const line = nodeToMarkdown(node);
      const cost = estimate(line);
      if (used + cost > tokenBudget) break;
      lines.push(line);
      used += cost;
    }

    const includedIds = new Set(sorted.map((n) => n.id));
    const edges = subgraph.edges.filter((e) => includedIds.has(e.fromId) && includedIds.has(e.toId));
    if (edges.length > 0) {
      lines.push('', '**Relationships:**');
      for (const edge of edges) {
        const line = edgeToMarkdown(edge);
        if (used + estimate(line) > tokenBudget) break;
        lines.push(line);
        used += estimate(line);
      }
    }

    return lines.join('\n');
  }
}

function sortByRelevance(subgraph: MemorySubgraph): MemoryNode[] {
  return [...subgraph.nodes].sort(
    (a, b) => (subgraph.relevanceScores.get(b.id) ?? 0) - (subgraph.relevanceScores.get(a.id) ?? 0),
  );
}

function nodeToXml(n: MemoryNode): string {
  const props = Object.entries(n.properties)
    .slice(0, 3)
    .map(([k, v]) => `${k}="${String(v).slice(0, 80)}"`)
    .join(' ');
  return `  <node id="${n.id.slice(0, 8)}" kind="${n.kind}" label="${n.label}"${props ? ' ' + props : ''}/>`;
}

function edgeToXml(e: MemoryEdge): string {
  return `  <edge from="${e.fromId.slice(0, 8)}" to="${e.toId.slice(0, 8)}" rel="${e.relation}"/>`;
}

function nodeToMarkdown(n: MemoryNode): string {
  return `- **${n.kind}** \`${n.label}\` (${n.id.slice(0, 8)})`;
}

function edgeToMarkdown(e: MemoryEdge): string {
  return `  - \`${e.fromId.slice(0, 8)}\` —[${e.relation}]→ \`${e.toId.slice(0, 8)}\``;
}

function estimate(text: string): number { return Math.ceil(text.length / 4); }
