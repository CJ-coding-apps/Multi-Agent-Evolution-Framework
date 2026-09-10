import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import type { Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy } from '@maf/types';
import { makeNodeId } from '@maf/types';

interface WorkflowSpec {
  id?:   string;
  nodes: Array<{
    id:            string;
    label:         string;
    agentRole?:    string;
    dependencies?: string[];
    timeoutMs?:    number;
    inputs?:       Record<string, string>;
    outputs?:      Record<string, string>;
    retry?:        Partial<RetryPolicy>;
  }>;
  edges?: Array<{ from: string; to: string; kind?: string }>;
  config?: Partial<DagConfig>;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000, backoffFactor: 2, jitterMs: 500 };
const DEFAULT_CONFIG: DagConfig  = { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY, timeoutMs: 600_000, reviewGateNodeIds: [] };

export class DagParser {
  // Parse WORKFLOW.md — reads the YAML front-matter fenced block
  static async fromMarkdownFile(filePath: string, runId: RunId, defaultRole: string = 'coder'): Promise<Dag> {
    const content = await readFile(filePath, 'utf8');
    return DagParser.fromMarkdown(content, runId, defaultRole);
  }

  static fromMarkdown(content: string, runId: RunId, defaultRole: string = 'coder'): Dag {
    // Extract YAML or JSON front-matter between ```yaml / ```json and ```
    const match = /```(?:yaml|json)\n([\s\S]+?)\n```/i.exec(content);
    if (!match?.[1]) throw new Error('WORKFLOW.md: no fenced yaml/json block found');
    return DagParser.fromYamlText(match[1], runId, defaultRole);
  }

  static fromYamlText(text: string, runId: RunId, defaultRole: string = 'coder'): Dag {
    let spec: WorkflowSpec;
    try {
      spec = JSON.parse(text) as WorkflowSpec;
    } catch {
      throw new Error(`DagParser: could not parse workflow spec as JSON. Install "yaml" package for YAML support.`);
    }
    return DagParser.fromSpec(spec, runId, defaultRole);
  }

  static fromSpec(spec: WorkflowSpec, runId: RunId, defaultRole: string = 'coder'): Dag {
    const nodes = new Map<NodeId, DagNode>();

    for (const n of spec.nodes) {
      const id = makeNodeId(n.id);
      nodes.set(id, {
        id,
        label:        n.label,
        agentRole:    n.agentRole ?? defaultRole,
        dependencies: (n.dependencies ?? []).map(makeNodeId),
        retryPolicy:  { ...DEFAULT_RETRY, ...n.retry },
        timeoutMs:    n.timeoutMs ?? 300_000,
        inputs:       (n.inputs  ?? {}) as Record<string, import('@maf/types').BlackboardKey>,
        outputs:      (n.outputs ?? {}) as Record<string, import('@maf/types').BlackboardKey>,
        metadata:     {},
      });
    }

    const edges: DagEdge[] = (spec.edges ?? []).map((e) => ({
      id:   crypto.randomUUID() as EdgeId,
      from: makeNodeId(e.from),
      to:   makeNodeId(e.to),
      kind: (e.kind ?? 'control') as DagEdge['kind'],
    }));

    const config: DagConfig = {
      ...DEFAULT_CONFIG,
      ...spec.config,
      retryPolicy: { ...DEFAULT_RETRY, ...spec.config?.retryPolicy },
      reviewGateNodeIds: (spec.config?.reviewGateNodeIds ?? []).map(makeNodeId),
    };

    return { id: spec.id ?? crypto.randomUUID(), runId, nodes, edges, config };
  }
}
