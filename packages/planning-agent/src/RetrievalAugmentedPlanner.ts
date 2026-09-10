import crypto from 'node:crypto';
import type {
  Dag, DagNode, DagEdge, DagConfig, NodeId, EdgeId, RunId, RetryPolicy,
} from '@maf/types';
import { makeNodeId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import type { LcmEngine } from '@maf/lcm';
import type { GraphAwareInjector } from '@maf/prompt-injector';

export interface RoleCatalogEntry {
  role:        string;
  description: string;
}

export interface PlannerConfig {
  graph:        MemoryGraph;
  lcm:          LcmEngine;
  injector:     GraphAwareInjector;
  defaultRole?: string;
  roleCatalog?: RoleCatalogEntry[];
  validRoles?:  ReadonlySet<string>;
  // Injected: calls the underlying adapter to generate plan text
  generatePlan(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface TaskDescription {
  title:       string;
  description: string;
  runId:       RunId;
  sessionId:   string;
}

export class RetrievalAugmentedPlanner {
  constructor(private readonly config: PlannerConfig) {}

  async plan(task: TaskDescription): Promise<Dag> {
    // 1. Retrieve past failures on similar tasks
    const failureContext = await this.getFailureContext(task.title);

    // 2. Retrieve relevant transcript history
    const transcriptContext = await this.getTranscriptContext(task.title, task.sessionId);

    // 3. Build memory-augmented system prompt
    const { systemPromptPrefix } = await this.config.injector.assemble(task.title, task.sessionId);

    const systemPrompt = [
      systemPromptPrefix,
      failureContext,
      transcriptContext,
      this.buildPlanningInstructions(),
    ].filter(Boolean).join('\n\n');

    // 4. Generate DAG spec from adapter
    const userPrompt = `Create a task execution DAG for: ${task.title}\n\n${task.description}`;
    const planText = await this.config.generatePlan(systemPrompt, userPrompt);

    // 5. Parse plan text → Dag, preserving original task for executor context
    return this.parsePlan(planText, task.runId, task);
  }

  private buildPlanningInstructions(): string {
    const defaultRole = this.config.defaultRole ?? 'coder';
    const catalog = this.config.roleCatalog ?? [];
    if (catalog.length === 0) return PLANNING_INSTRUCTIONS_BASE(defaultRole);
    const rolesBlock = catalog.map((r) => `- ${r.role}${r.role === defaultRole ? ' (default)' : ''}: ${r.description}`).join('\n');
    return PLANNING_INSTRUCTIONS_BASE(defaultRole) + `\n\nAvailable agent roles (use these in node.agentRole):\n${rolesBlock}\n\nGuidance:\n- After any coder node that introduces new behavior, emit a tester node that depends on it.\n- When a task touches authentication, parsing of user input, secrets, or external network calls, emit an explicit security node. (A lightweight automatic security scan also runs on every coder diff.)`;
  }

  private async getFailureContext(title: string): Promise<string> {
    const keywords = title.split(' ').slice(0, 3).join(' ');
    const rows = await this.config.graph.query(
      `MATCH (t:MemoryNode {kind: 'Task'})-[:CAUSED_FAILURE]->(f:MemoryNode {kind: 'Failure'})
       WHERE t.label CONTAINS $kw
       RETURN t.label AS task, f.properties AS failure LIMIT 5`,
      { kw: keywords },
    ) as Array<{ task: string; failure: string }>;

    if (rows.length === 0) return '';

    const items = rows.map((r) => `- Task "${r.task}" → ${r.failure}`).join('\n');
    return `<past-failures>\nThese similar tasks failed previously — avoid repeating these patterns:\n${items}\n</past-failures>`;
  }

  private async getTranscriptContext(title: string, sessionId: string): Promise<string> {
    const keywords = title.split(' ').slice(0, 3).join(' ');
    const messages = await this.config.lcm.lcm_grep(keywords, sessionId);
    if (messages.length === 0) return '';

    const excerpts = messages.slice(0, 5).map((m) => `[${m.role}] ${m.content.slice(0, 200)}`).join('\n');
    return `<past-context>\nRelevant prior work on this session:\n${excerpts}\n</past-context>`;
  }

  private parsePlan(planText: string, runId: RunId, task?: TaskDescription): Dag {
    const defaultRole = this.config.defaultRole ?? 'coder';
    // Parse JSON plan block if present, otherwise create single-node DAG
    const jsonMatch = /```json\n([\s\S]+?)\n```/.exec(planText);
    if (jsonMatch?.[1]) {
      try {
        const spec = JSON.parse(jsonMatch[1]) as DagSpec;
        return specToDag(spec, runId, task, defaultRole, this.config.validRoles);
      } catch { /* fall through to default */ }
    }

    // Default: single "execute" node — pass task description so executor has context
    const nodeId = makeNodeId(crypto.randomUUID());
    const taskDescription = task?.description ?? task?.title ?? planText;
    const dag: Dag = {
      id:    crypto.randomUUID(),
      runId,
      nodes: new Map([[nodeId, {
        id:           nodeId,
        label:        task?.title ?? 'execute',
        agentRole:    defaultRole,
        dependencies: [],
        retryPolicy:  DEFAULT_RETRY,
        timeoutMs:    300_000,
        inputs:       {},
        outputs:      {},
        metadata:     { taskDescription, planText },
      }]]),
      edges:  [],
      config: DEFAULT_DAG_CONFIG,
    };
    return dag;
  }
}

interface DagSpec {
  nodes: Array<{
    id: string; label: string; description?: string; agentRole?: string;
    dependencies?: string[]; timeoutMs?: number;
  }>;
  edges?: Array<{ from: string; to: string; kind?: string }>;
}

function specToDag(
  spec: DagSpec,
  runId: RunId,
  task: TaskDescription | undefined,
  defaultRole: string,
  validRoles?: ReadonlySet<string>,
): Dag {
  const nodes = new Map<NodeId, DagNode>();
  for (const n of spec.nodes) {
    const id = makeNodeId(n.id);
    const requested = n.agentRole;
    const role = resolveRoleOrWarn(requested, defaultRole, validRoles);
    nodes.set(id, {
      id,
      label:        n.label,
      agentRole:    role,
      dependencies: (n.dependencies ?? []).map(makeNodeId),
      retryPolicy:  DEFAULT_RETRY,
      timeoutMs:    n.timeoutMs ?? 300_000,
      inputs:       {},
      outputs:      {},
      metadata:     { taskDescription: n.description ?? task?.description ?? task?.title ?? n.label },
    });
  }
  const edges: DagEdge[] = (spec.edges ?? []).map((e) => ({
    id:   crypto.randomUUID() as EdgeId,
    from: makeNodeId(e.from),
    to:   makeNodeId(e.to),
    kind: (e.kind ?? 'control') as DagEdge['kind'],
  }));
  return { id: crypto.randomUUID(), runId, nodes, edges, config: DEFAULT_DAG_CONFIG };
}

function resolveRoleOrWarn(
  requested: string | undefined,
  defaultRole: string,
  validRoles: ReadonlySet<string> | undefined,
): string {
  if (!requested) return defaultRole;
  if (!validRoles) return requested;
  if (validRoles.has(requested)) return requested;
  console.warn(`[planner] unknown agentRole "${requested}" — falling back to "${defaultRole}"`);
  return defaultRole;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000, backoffFactor: 2, jitterMs: 500 };
const DEFAULT_DAG_CONFIG: DagConfig = { maxConcurrent: 4, retryPolicy: DEFAULT_RETRY, timeoutMs: 600_000, reviewGateNodeIds: [] };

const PLANNING_INSTRUCTIONS_BASE = (defaultRole: string): string => `
You are a planning agent. Respond with a JSON code block containing a DAG specification.
Each node's "description" field is the FULL instruction given to the agent for that step — be specific and detailed.

\`\`\`json
{
  "nodes": [
    {
      "id": "n1",
      "label": "short step name",
      "description": "Full detailed instruction for the agent: what to investigate, what to change, what files to look at, what the fix should accomplish.",
      "agentRole": "${defaultRole}",
      "dependencies": [],
      "timeoutMs": 300000
    }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "kind": "control" }
  ]
}
\`\`\`

Rules:
- description must be self-contained — the agent sees ONLY that field, nothing else
- Each node is an independent agent task
- dependencies[] lists node IDs that must complete before this node runs
- Avoid patterns listed in past-failures
- For simple single-step tasks, use exactly one node
`;
