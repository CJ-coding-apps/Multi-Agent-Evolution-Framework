import type { RunId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import type { GoldenSuiteResult } from './GoldenRunner.js';

/**
 * ScoreRecorder — persists golden-suite results into the memory graph so the
 * Phase 3 Digester can read evolution history (GoldenResult nodes + SCORED_BY
 * edge to the run node for the harness's producing run).
 */
export class ScoreRecorder {
  constructor(
    private readonly graph: MemoryGraph,
    private readonly runId: RunId,
  ) {}

  async record(result: GoldenSuiteResult): Promise<void> {
    const goldenId = await this.graph.addNode({
      kind: 'GoldenResult',
      label: `goldens ${result.harnessId} @ ${result.ranAt}`,
      properties: {
        harnessId: result.harnessId,
        harness_sha: result.harnessSha,
        solved: result.solvedTaskIds,
        total: result.tasks.length,
        ranAt: result.ranAt,
        perTask: result.tasks.map((t) => ({
          taskId: t.taskId,
          passed: t.passed,
          role: t.role,
        })),
      },
      runId: this.runId,
    });

    // Best-effort: the score node is already written, so a graph that cannot answer this lookup
    // must not fail the golden suite. The tolerance is stated here rather than implied by a
    // query method that quietly returned `[]`.
    let runs: Array<Record<string, unknown>> = [];
    try {
      runs = await this.graph.run({
        cypher: "MATCH (n:MemoryNode) WHERE n.run_id = $runId AND n.kind = 'Run' RETURN n.id LIMIT 1",
        params: { runId: this.runId },
      });
    } catch { /* no run node to link */ }
    const runNodeId = runs[0]?.['n.id'];
    if (typeof runNodeId === 'string') {
      await this.graph.addEdge({
        fromId: runNodeId,
        toId: goldenId,
        relation: 'SCORED_BY',
        weight: 1,
        metadata: { harness_sha: result.harnessSha },
      });
    }
  }
}
