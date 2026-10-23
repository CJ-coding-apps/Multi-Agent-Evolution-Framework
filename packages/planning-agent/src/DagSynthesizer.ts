import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type {
  Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy, RoleName, RoleResolver,
} from '@maf/types';
import { makeNodeId, DEFAULT_RETRY_POLICY, MAX_TIMER_MS } from '@maf/types';
import type { FailurePattern } from './FailurePatternDetector.js';

const DEFAULT_RETRY: RetryPolicy = DEFAULT_RETRY_POLICY;
const DEFAULT_CONFIG: DagConfig  = { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY, timeoutMs: 600_000, reviewGateNodeIds: [] };

/**
 * The most one `--plan-from` file may ask for (WP-3.6, F11). The spec is an operator's file, and
 * these bound what one file can make the scheduler do: 1 MiB is many times a 200-node plan, 200
 * nodes is more than a person writes by hand, and an edge only expresses an order, so 2000 of them
 * over 200 nodes is far past the point a plan is readable.
 */
export const MAX_SPEC_BYTES = 1024 * 1024;
export const MAX_SPEC_NODES = 200;
export const MAX_SPEC_EDGES = 2000;

/**
 * The spec `--plan-from` reads, and the only keys it accepts (F6). A spec is a plan, not a run
 * config: `config`, `retry`, `inputs` and `outputs` are refused by name rather than ignored, so a
 * key the operator expected to act cannot sit in the file doing nothing. `DagParser.fromSpec` reads
 * the wider WORKFLOW.md form; this is the narrower format `--plan-from` documents.
 */
const SPEC_KEYS = new Set(['id', 'nodes', 'edges']);
const NODE_KEYS = new Set(['id', 'label', 'agentRole', 'dependencies', 'timeoutMs', 'metadata']);
const EDGE_KEYS = new Set(['from', 'to', 'kind']);
const EDGE_KINDS = new Set<string>(['data', 'control', 'review']);

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

/** What a caller may add to a synthesized DAG (WP-3.6, F7). */
export interface SynthesisOptions {
  /**
   * Failure patterns to steer review insertion with. `--plan-from` passes none: a spec is the
   * operator's plan, and recall must not alter it.
   */
  avoidPatterns?: FailurePattern[];
  /** The run's title, carried on every node so recall can find this plan's failures (D-16). */
  runTitle?: string;
}

/** A spec file as read, with the digest of the bytes that were read (WP-3.6, F4). */
export interface SynthesisFile {
  dag:    Dag;
  sha256: string;
}

export class DagSynthesizer {
  /**
   * The role set in force decides which role names exist. It is injected rather than
   * defaulted to a literal: a synthesizer that named `'coder'` itself could emit a role
   * no registry defines, and the node would then be dispatched under it.
   */
  constructor(private readonly roles: RoleResolver) {}

  /**
   * Build a Dag from a spec, automatically inserting review gates for nodes that touch files known
   * to have caused failures. The spec is validated in full first (F5): every refusal below happens
   * before the caller has created a branch, a worktree or a store, because `--plan-from` synthesizes
   * before any of those (F1).
   */
  synthesize(spec: SynthesisSpec, runId: RunId, opts: SynthesisOptions = {}): Dag {
    const checked = validateSpec(spec, 'DagSynthesizer');
    const avoidPatterns = opts.avoidPatterns ?? [];
    const failedLabels = new Set(avoidPatterns.map((p) => p.taskLabel.toLowerCase()));
    const nodes = new Map<NodeId, DagNode>();
    const reviewGateNodeIds: NodeId[] = [];

    for (const n of checked.nodes) {
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
        metadata:     {
          ...(n.metadata ?? {}),
          // The run's title, on every node it synthesized (D-16): a failure here is recorded under
          // the run the operator named, so a later recall of that title finds what this plan broke.
          // Each node's `taskDescription` stays its own step, as a planned node's does: it is the
          // task the dispatcher hands the model, so the run's title must not replace it.
          ...(opts.runTitle !== undefined && opts.runTitle.trim() !== ''
            ? {
                ...(n.metadata?.['taskDescription'] === undefined ? { taskDescription: n.label } : {}),
                runTitle: opts.runTitle,
              }
            : {}),
        },
      });
    }

    const known = new Set(nodes.keys());
    for (const node of nodes.values()) {
      for (const dep of node.dependencies) {
        if (dep === node.id) throw new Error(`DagSynthesizer: node "${node.id}" depends on itself`);
        if (!known.has(dep)) {
          throw new Error(
            `DagSynthesizer: node "${node.id}" depends on unknown node "${dep}"; ` +
            'a dependency has to name a node the spec defines.',
          );
        }
      }
    }

    const edges: DagEdge[] = (checked.edges ?? []).map((e, i) => ({
      // Content, not the clock: `--plan-from` must produce the same DAG every time it reads a spec.
      id:   `e${i}:${e.from}->${e.to}:${e.kind ?? 'control'}` as EdgeId,
      from: makeNodeId(e.from),
      to:   makeNodeId(e.to),
      kind: (e.kind ?? 'control') as DagEdge['kind'],
    }));
    // An edge is an ordering constraint. The scheduler reads `dependencies`, so before this an
    // edge-only spec ran its nodes concurrently — see the same rule in `DagParser.fromSpec`.
    for (const edge of edges) {
      if (edge.from === edge.to) {
        throw new Error(`DagSynthesizer: edge "${edge.from}" -> "${edge.to}" makes a node depend on itself`);
      }
      const target = nodes.get(edge.to);
      if (!known.has(edge.from)) throw new Error(`DagSynthesizer: edge names unknown node "${edge.from}" (from)`);
      if (target === undefined) throw new Error(`DagSynthesizer: edge names unknown node "${edge.to}" (to)`);
      if (!target.dependencies.includes(edge.from)) target.dependencies.push(edge.from);
    }
    assertAcyclic('DagSynthesizer', nodes);

    return {
      id:     checked.id ?? contentId(checked),
      runId,
      nodes,
      edges,
      config: { ...DEFAULT_CONFIG, reviewGateNodeIds },
    };
  }

  /**
   * Reads a spec file. JSON only: `@maf/planning-agent` does not carry a YAML parser, and adding one
   * would be a new dependency for a format the planner's own output never uses. The size is read
   * before the bytes are, so a file far past what a plan looks like is refused without loading it.
   * Returns the digest of the bytes it read, which the run records as the plan's source (F4).
   */
  async fromFile(filePath: string, runId: RunId, opts: SynthesisOptions = {}): Promise<SynthesisFile> {
    let text: string;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('it is not a regular file');
      if (info.size > MAX_SPEC_BYTES) {
        throw new Error(`it is ${info.size} bytes; a spec may be at most ${MAX_SPEC_BYTES}`);
      }
      text = await readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(
        `DagSynthesizer: could not read ${filePath} as a JSON workflow spec ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `DagSynthesizer: could not read ${filePath} as a JSON workflow spec ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { nodes?: unknown }).nodes)) {
      throw new Error(`DagSynthesizer: ${filePath} must contain a JSON object with a "nodes" array.`);
    }
    return {
      dag:    this.synthesize(parsed as SynthesisSpec, runId, opts),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
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

/**
 * A closed schema, checked before anything is built (WP-3.6, F5/F6). Every shape the runtime would
 * otherwise raise its own `TypeError` about is refused here with the spec's own words, and a key the
 * format does not define is refused by name: a typo (`agnetRole`) used to be dropped, which silently
 * gave the node the default role — the writer.
 */
function validateSpec(raw: unknown, who: string): SynthesisSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${who}: a spec must be a JSON object.`);
  }
  const spec = raw as Record<string, unknown>;
  refuseUnknownKeys(who, 'the spec', spec, SPEC_KEYS);
  if (spec['id'] !== undefined && typeof spec['id'] !== 'string') {
    throw new Error(`${who}: the spec's "id" must be a string.`);
  }
  const rawNodes = spec['nodes'];
  if (!Array.isArray(rawNodes)) {
    throw new Error(`${who}: the spec must contain a JSON object with a "nodes" array.`);
  }
  if (rawNodes.length === 0) {
    throw new Error(`${who}: the spec has no nodes; a plan needs at least one.`);
  }
  if (rawNodes.length > MAX_SPEC_NODES) {
    throw new Error(`${who}: the spec has ${rawNodes.length} nodes; at most ${MAX_SPEC_NODES} are accepted.`);
  }

  const nodes: SynthesisSpec['nodes'] = [];
  for (const [i, rawNode] of rawNodes.entries()) {
    if (rawNode === null || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      throw new Error(`${who}: node ${i} is not an object.`);
    }
    const node = rawNode as Record<string, unknown>;
    const where = typeof node['id'] === 'string' && node['id'] !== '' ? `node "${node['id'] as string}"` : `node ${i}`;
    refuseUnknownKeys(who, where, node, NODE_KEYS);
    if (typeof node['id'] !== 'string' || node['id'] === '') {
      throw new Error(`${who}: ${where} needs a non-empty string "id".`);
    }
    if (typeof node['label'] !== 'string' || node['label'].trim() === '') {
      throw new Error(`${who}: ${where} needs a non-empty string "label".`);
    }
    if (node['agentRole'] !== undefined && typeof node['agentRole'] !== 'string') {
      throw new Error(`${who}: ${where} "agentRole" must be a string.`);
    }
    const deps = node['dependencies'];
    if (deps !== undefined) {
      if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || d === '')) {
        throw new Error(`${who}: ${where} "dependencies" must be an array of node ids.`);
      }
    }
    const timeout = node['timeoutMs'];
    // The same bound `.maf/config.yaml` uses, and the same reason (R3): Node fires any delay above
    // `MAX_TIMER_MS` after 1 ms, so a larger timeout would mean "at once" rather than "never". Above
    // it the spec asks for the opposite of what it says, so it is refused rather than clamped.
    if (timeout !== undefined
      && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_MS)) {
      throw new Error(
        `${who}: ${where} "timeoutMs" must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`,
      );
    }
    const metadata = node['metadata'];
    if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
      throw new Error(`${who}: ${where} "metadata" must be an object.`);
    }
    nodes.push({
      id:      node['id'],
      label:   node['label'],
      ...(node['agentRole'] !== undefined ? { agentRole: node['agentRole'] as string } : {}),
      ...(deps !== undefined ? { dependencies: deps as string[] } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout as number } : {}),
      ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
    });
  }

  const rawEdges = spec['edges'];
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    throw new Error(`${who}: the spec's "edges" must be an array.`);
  }
  const edges: NonNullable<SynthesisSpec['edges']> = [];
  for (const [i, rawEdge] of (rawEdges ?? []).entries()) {
    if (rawEdge === null || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) {
      throw new Error(`${who}: edge ${i} is not an object.`);
    }
    const edge = rawEdge as Record<string, unknown>;
    refuseUnknownKeys(who, `edge ${i}`, edge, EDGE_KEYS);
    if (typeof edge['from'] !== 'string' || edge['from'] === '') {
      throw new Error(`${who}: edge ${i} needs a non-empty string "from".`);
    }
    if (typeof edge['to'] !== 'string' || edge['to'] === '') {
      throw new Error(`${who}: edge ${i} needs a non-empty string "to".`);
    }
    if (edge['kind'] !== undefined && (typeof edge['kind'] !== 'string' || !EDGE_KINDS.has(edge['kind']))) {
      throw new Error(
        `${who}: edge ${i} has unknown "kind" ${JSON.stringify(edge['kind'])}; ` +
        `accepted kinds are ${[...EDGE_KINDS].join(', ')}.`,
      );
    }
    edges.push({
      from: edge['from'],
      to:   edge['to'],
      ...(edge['kind'] !== undefined ? { kind: edge['kind'] as string } : {}),
    });
  }
  if (edges.length > MAX_SPEC_EDGES) {
    throw new Error(`${who}: the spec has ${edges.length} edges; at most ${MAX_SPEC_EDGES} are accepted.`);
  }

  return {
    ...(spec['id'] !== undefined ? { id: spec['id'] as string } : {}),
    nodes,
    ...(rawEdges !== undefined ? { edges } : {}),
  };
}

/** A key the format does not define is refused by name, not dropped (F6). */
function refuseUnknownKeys(who: string, where: string, value: Record<string, unknown>, accepted: ReadonlySet<string>): void {
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length === 0) return;
  const named = unknown.map((key) => JSON.stringify(key)).join(', ');
  throw new Error(
    `${who}: ${where} has unknown key(s) ${named}; a spec accepts ${[...accepted].map((k) => `"${k}"`).join(', ')}.`,
  );
}

/**
 * A cycle makes the DAG unschedulable, and the runner's verdict for that arrives only after the
 * worktree exists; a spec can be refused before anything runs instead. Kahn's algorithm, so the
 * message can name every node still waiting on another.
 */
function assertAcyclic(who: string, nodes: ReadonlyMap<NodeId, DagNode>): void {
  const dependents = new Map<NodeId, NodeId[]>();
  const waiting = new Map<NodeId, number>();
  for (const id of nodes.keys()) {
    dependents.set(id, []);
    waiting.set(id, 0);
  }
  for (const node of nodes.values()) {
    waiting.set(node.id, node.dependencies.length);
    for (const dep of node.dependencies) dependents.get(dep)?.push(node.id);
  }
  const ready = [...waiting.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let seen = 0;
  while (ready.length > 0) {
    const id = ready.pop() as NodeId;
    seen += 1;
    for (const next of dependents.get(id) ?? []) {
      const count = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (seen === nodes.size) return;
  const inCycle = [...waiting.entries()].filter(([, count]) => count > 0).map(([id]) => `"${id}"`);
  throw new Error(
    `${who}: the spec has a dependency cycle among ${inCycle.join(', ')}; ` +
    'a node cannot wait for itself, directly or through other nodes.',
  );
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
