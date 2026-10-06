import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import type {
  Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy, RoleName, RoleResolver,
} from '@maf/types';
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
  static async fromMarkdownFile(filePath: string, runId: RunId, roles: RoleResolver): Promise<Dag> {
    const content = await readFile(filePath, 'utf8');
    return DagParser.fromMarkdown(content, runId, roles);
  }

  static fromMarkdown(content: string, runId: RunId, roles: RoleResolver): Dag {
    // Extract YAML or JSON front-matter between ```yaml / ```json and ```
    const match = /```(?:yaml|json)\n([\s\S]+?)\n```/i.exec(content);
    if (!match?.[1]) throw new Error('WORKFLOW.md: no fenced yaml/json block found');
    return DagParser.fromYamlText(match[1], runId, roles);
  }

  static fromYamlText(text: string, runId: RunId, roles: RoleResolver): Dag {
    let spec: WorkflowSpec;
    try {
      spec = JSON.parse(text) as WorkflowSpec;
    } catch {
      throw new Error(`DagParser: could not parse workflow spec as JSON. Install "yaml" package for YAML support.`);
    }
    return DagParser.fromSpec(spec, runId, roles);
  }

  static fromSpec(spec: WorkflowSpec, runId: RunId, roles: RoleResolver): Dag {
    const nodes = new Map<NodeId, DagNode>();

    for (const n of spec.nodes) {
      const id = makeNodeId(n.id);
      // A Map would silently keep only the last of two same-id nodes, so the
      // duplicate has to be caught while the spec is still a list.
      if (nodes.has(id)) throw new Error(`DagParser: duplicate node id "${n.id}"`);
      nodes.set(id, {
        id,
        label:        n.label,
        agentRole:    resolveNodeRole(n.agentRole, roles, n.id),
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

/**
 * The role a node runs as: the one it asked for, or the resolver's default when it asked
 * for none.
 *
 * "Asked for none" is an absent field or an empty one — a node naming no role gets the
 * set's default, which is what `?? defaultRole` gave it before. That is not a downgrade:
 * the default is a role this set defines, and picking it is the operator's, via
 * `defaultRole`.
 *
 * A name the set does *not* define is a different thing, and it is an error. The old code
 * wrote `n.agentRole ?? defaultRole` straight into a `string` field, so a typo in a
 * WORKFLOW.md reached the dispatcher, which fell back to the default role — `coder`, a
 * writer. A workflow that misspells `reviewer` must not silently become a workflow that
 * edits code.
 */
function resolveNodeRole(
  requested: string | undefined,
  roles: RoleResolver,
  nodeId: string,
): RoleName {
  if (requested === undefined || requested === '') return roles.defaultRole;
  const resolved = roles.resolveRole(requested);
  if (!resolved.ok) {
    throw new Error(
      `DagParser: node "${nodeId}" asks for unknown agentRole "${requested}". ` +
      `Known roles: ${resolved.error.known.join(', ')}.`,
    );
  }
  return resolved.value;
}
