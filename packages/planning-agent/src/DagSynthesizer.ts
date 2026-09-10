import crypto from 'node:crypto';
import type { Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy } from '@maf/types';
import { makeNodeId } from '@maf/types';
import type { FailurePattern } from './FailurePatternDetector.js';

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000, backoffFactor: 2, jitterMs: 500 };
const DEFAULT_CONFIG: DagConfig  = { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY, timeoutMs: 600_000, reviewGateNodeIds: [] };

export interface SynthesisSpec {
  nodes: Array<{
    id:           string;
    label:        string;
    agentRole?:   string;
    dependencies?: string[];
    timeoutMs?:   number;
    metadata?:    Record<string, unknown>;
  }>;
  edges?: Array<{ from: string; to: string; kind?: string }>;
}

export class DagSynthesizer {
  constructor(private readonly defaultRole: string = 'coder') {}

  // Build a Dag from a spec, automatically inserting review gates for nodes
  // that touch files known to have caused failures.
  synthesize(spec: SynthesisSpec, runId: RunId, avoidPatterns: FailurePattern[] = []): Dag {
    const failedLabels = new Set(avoidPatterns.map((p) => p.taskLabel.toLowerCase()));
    const nodes = new Map<NodeId, DagNode>();
    const reviewGateNodeIds: NodeId[] = [];

    for (const n of spec.nodes) {
      const id = makeNodeId(n.id);
      const needsReview = avoidPatterns.length > 0 && this.mightRepeatFailure(n.label, failedLabels);

      if (needsReview) {
        reviewGateNodeIds.push(id);
      }

      nodes.set(id, {
        id,
        label:        n.label,
        agentRole:    n.agentRole ?? this.defaultRole,
        dependencies: (n.dependencies ?? []).map(makeNodeId),
        retryPolicy:  DEFAULT_RETRY,
        timeoutMs:    n.timeoutMs ?? 300_000,
        inputs:       {},
        outputs:      {},
        metadata:     n.metadata ?? {},
      });
    }

    const edges: DagEdge[] = (spec.edges ?? []).map((e) => ({
      id:   crypto.randomUUID() as EdgeId,
      from: makeNodeId(e.from),
      to:   makeNodeId(e.to),
      kind: (e.kind ?? 'control') as DagEdge['kind'],
    }));

    return {
      id:     crypto.randomUUID(),
      runId,
      nodes,
      edges,
      config: { ...DEFAULT_CONFIG, reviewGateNodeIds },
    };
  }

  // Single-node DAG for simple tasks
  singleNode(label: string, runId: RunId, metadata: Record<string, unknown> = {}): Dag {
    return this.synthesize({ nodes: [{ id: 'n1', label, metadata }] }, runId);
  }

  private mightRepeatFailure(label: string, failedLabels: Set<string>): boolean {
    const lower = label.toLowerCase();
    return [...failedLabels].some((failed) => {
      const words = failed.split(/\s+/);
      return words.some((w) => w.length > 3 && lower.includes(w));
    });
  }
}
