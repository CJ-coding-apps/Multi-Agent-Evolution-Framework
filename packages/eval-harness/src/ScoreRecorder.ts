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

    const runs = await this.graph.query(
      "MATCH (n:MemoryNode) WHERE n.run_id = $runId AND n.kind = 'Run' RETURN n.id LIMIT 1",
      { runId: this.runId },
    );
    const runNodeId = (runs[0] as Record<string, unknown> | undefined)?.['n.id'];
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
