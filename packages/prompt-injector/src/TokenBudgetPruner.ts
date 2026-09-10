import type { MemoryNode, MemoryEdge, MemorySubgraph } from '@maf/types';

export class TokenBudgetPruner {
  prune(subgraph: MemorySubgraph, tokenBudget: number): MemorySubgraph {
    if (tokenBudget <= 0) return empty(subgraph.queryContext);

    // Sort nodes by relevance descending
    const sorted = [...subgraph.nodes].sort(
      (a, b) => (subgraph.relevanceScores.get(b.id) ?? 0) - (subgraph.relevanceScores.get(a.id) ?? 0),
    );

    const includedNodes: MemoryNode[] = [];
    let used = 0;

    for (const node of sorted) {
      const cost = estimateNode(node);
      if (used + cost > tokenBudget) break;
      includedNodes.push(node);
      used += cost;
    }

    const includedIds = new Set(includedNodes.map((n) => n.id));

    const includedEdges: MemoryEdge[] = [];
    for (const edge of subgraph.edges) {
      if (!includedIds.has(edge.fromId) || !includedIds.has(edge.toId)) continue;
      const cost = estimateEdge(edge);
      if (used + cost > tokenBudget) break;
      includedEdges.push(edge);
      used += cost;
    }

    const relevanceScores = new Map(
      includedNodes.map((n) => [n.id, subgraph.relevanceScores.get(n.id) ?? 0]),
    );

    return { nodes: includedNodes, edges: includedEdges, queryContext: subgraph.queryContext, relevanceScores };
  }

  // Estimate token cost for a single node (label + kind + top properties)
  estimateNodeCost(node: MemoryNode): number { return estimateNode(node); }
}

function estimateNode(n: MemoryNode): number {
  return Math.ceil((n.kind.length + n.label.length + JSON.stringify(n.properties).length) / 4);
}

function estimateEdge(e: MemoryEdge): number {
  return Math.ceil((e.relation.length + e.fromId.length + e.toId.length) / 4);
}

function empty(ctx: string): MemorySubgraph {
  return { nodes: [], edges: [], queryContext: ctx, relevanceScores: new Map() };
}
