import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy, RoleName, RoleResolver,
} from '@maf/types';
import { makeNodeId, DEFAULT_RETRY_POLICY } from '@maf/types';
import type { FailurePattern } from './FailurePatternDetector.js';

const DEFAULT_RETRY: RetryPolicy = DEFAULT_RETRY_POLICY;
const DEFAULT_CONFIG: DagConfig  = { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY, timeoutMs: 600_000, reviewGateNodeIds: [] };

export interface SynthesisSpec {
  /** Recorded as the DAG's id. Absent, the id is derived from the content. */
  id?: string;
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
  /**
   * The role set in force decides which role names exist. It is injected rather than
   * defaulted to a literal: a synthesizer that named `'coder'` itself could emit a role
   * no registry defines, and the node would then be dispatched under it.
   */
  constructor(private readonly roles: RoleResolver) {}

  // Build a Dag from a spec, automatically inserting review gates for nodes
  // that touch files known to have caused failures.
  synthesize(spec: SynthesisSpec, runId: RunId, avoidPatterns: FailurePattern[] = []): Dag {
    const failedLabels = new Set(avoidPatterns.map((p) => p.taskLabel.toLowerCase()));
    const nodes = new Map<NodeId, DagNode>();
    const reviewGateNodeIds: NodeId[] = [];

    for (const n of spec.nodes) {
      const id = makeNodeId(n.id);
      // A Map would keep only the last of two same-id nodes, so the duplicate is refused while the
      // spec is still a list — as `DagParser.fromSpec` does, for the same reason.
      if (nodes.has(id)) throw new Error(`DagSynthesizer: duplicate node id "${n.id}"`);
      const needsReview = avoidPatterns.length > 0 && this.mightRepeatFailure(n.label, failedLabels);

      if (needsReview) {
        reviewGateNodeIds.push(id);
      }

      nodes.set(id, {
        id,
        label:        n.label,
        agentRole:    synthesizeNodeRole(n.agentRole, this.roles, n.id),
        dependencies: (n.dependencies ?? []).map(makeNodeId),
        retryPolicy:  DEFAULT_RETRY,
        timeoutMs:    n.timeoutMs ?? 300_000,
        inputs:       {},
        outputs:      {},
        metadata:     n.metadata ?? {},
      });
    }

    const edges: DagEdge[] = (spec.edges ?? []).map((e, i) => ({
      // Content, not the clock: `--plan-from` must produce the same DAG every time it reads a spec.
      id:   `e${i}:${e.from}->${e.to}:${e.kind ?? 'control'}` as EdgeId,
      from: makeNodeId(e.from),
      to:   makeNodeId(e.to),
      kind: (e.kind ?? 'control') as DagEdge['kind'],
    }));
    // An edge is an ordering constraint. The scheduler reads `dependencies`, so before this an
    // edge-only spec ran its nodes concurrently — see the same rule in `DagParser.fromSpec`.
    for (const edge of edges) {
      const target = nodes.get(edge.to);
      if (!nodes.has(edge.from)) throw new Error(`DagSynthesizer: edge names unknown node "${edge.from}" (from)`);
      if (target === undefined) throw new Error(`DagSynthesizer: edge names unknown node "${edge.to}" (to)`);
      if (!target.dependencies.includes(edge.from)) target.dependencies.push(edge.from);
    }

    return {
      id:     spec.id ?? contentId(spec),
      runId,
      nodes,
      edges,
      config: { ...DEFAULT_CONFIG, reviewGateNodeIds },
    };
  }

  /**
   * Reads a spec file. JSON only: `@maf/planning-agent` does not carry a YAML parser, and adding one
   * would be a new dependency for a format the planner's own output never uses.
   */
  async fromFile(filePath: string, runId: RunId, avoidPatterns: FailurePattern[] = []): Promise<Dag> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `DagSynthesizer: could not read ${filePath} as a JSON workflow spec ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    const spec = parsed as Partial<SynthesisSpec> | null;
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.nodes)) {
      throw new Error(`DagSynthesizer: ${filePath} must contain a JSON object with a "nodes" array.`);
    }
    return this.synthesize(spec as SynthesisSpec, runId, avoidPatterns);
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

/** A stable id for a spec that names none: the same content always mints the same id. */
function contentId(spec: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

/**
 * See `DagParser.resolveNodeRole` and `RetrievalAugmentedPlanner.resolveRole` — one rule
 * at all three builders: absent-or-empty means "no role named", anything else must be a
 * name the set defines, and a name it does not define is refused rather than downgraded.
 */
function synthesizeNodeRole(
  requested: string | undefined,
  roles: RoleResolver,
  nodeId: string,
): RoleName {
  if (requested === undefined || requested === '') return roles.defaultRole;
  const resolved = roles.resolveRole(requested);
  if (!resolved.ok) {
    throw new Error(
      `DagSynthesizer: node "${nodeId}" asks for unknown agentRole "${requested}". ` +
      `Known roles: ${resolved.error.known.join(', ')}.`,
    );
  }
  return resolved.value;
}
