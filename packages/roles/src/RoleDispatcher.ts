import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DagNode, RunId, RetryPolicy, BlackboardValue, CliAdapter, AdapterInvokeOptions,
} from '@maf/types';
import { makeTaskId } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { Attestor } from '@maf/attestation';
import type { MemoryGraph } from '@maf/memory-graph';
import type { TranscriptLogger } from '@maf/transcript';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { ReviewGate, SecurityReviewGate } from '@maf/git-ops';
import type { RoleRegistry } from './RoleRegistry.js';
import { RoleToolRegistry } from './RoleToolRegistry.js';

const execFileAsync = promisify(execFile);

export interface RoleDispatcherConfig {
  adapter:        CliAdapter;
  baseTools:      ToolRegistry;
  roles:          RoleRegistry;
  injector:       GraphAwareInjector;
  policy:         PolicyEngine;
  attestor:       Attestor;
  graph:          MemoryGraph;
  transcript:     TranscriptLogger;
  lcmBridge:      BlackboardToLcmAdapter;
  reviewGate?:    ReviewGate;
  securityGate?:  SecurityReviewGate;
  cwd:            string;
  sessionId:      string;
  runId:          RunId;
  modelOverride?: string;
}

export interface RoleNodeOutput {
  output: BlackboardValue;
}

const MAX_OUTPUT_BYTES        = 2 * 1024 * 1024;  // 2MB per node response
const MAX_STORED_OUTPUT_CHARS = 64_000;

export class RoleDispatcher {
  constructor(private readonly config: RoleDispatcherConfig) {}

  async runNode(node: DagNode): Promise<Record<string, BlackboardValue>> {
    const role = this.config.roles.getRole(node.agentRole);
    const taskId = makeTaskId(node.id);

    await this.config.transcript.append(
      'user',
      `[${role.role}] ${node.label}: ${JSON.stringify(node.metadata)}`,
      { agentRole: role.role, nodeId: node.id },
    );

    const roleTools = new RoleToolRegistry(this.config.baseTools, role.allowedTools);
    const rolePrompt = await this.config.roles.loadPrompt(role);

    const { systemPromptPrefix } = await this.config.injector.assemble(
      node.label, this.config.sessionId, role.role,
    );
    const systemPrompt = [systemPromptPrefix, rolePrompt].filter(Boolean).join('\n');

    const nodeTask = (node.metadata as Record<string, unknown>)['taskDescription'];
    const userPrompt = typeof nodeTask === 'string' && nodeTask ? nodeTask : node.label;

    const invokeOpts: AdapterInvokeOptions = {
      prompt:         userPrompt,
      systemPrompt,
      tools:          roleTools.getAll(),
      workingDir:     this.config.cwd,
      timeoutMs:      role.timeoutMs ?? node.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    const modelChoice = role.model ?? this.config.modelOverride;
    if (modelChoice) invokeOpts.model = modelChoice;
    if (role.tokenBudget) invokeOpts.tokenBudget = role.tokenBudget;

    const result = await this.config.adapter.invoke(invokeOpts);

    const outputForMemory = result.output.slice(0, MAX_STORED_OUTPUT_CHARS);
    await this.config.transcript.append('assistant', outputForMemory, { agentRole: role.role, nodeId: node.id });
    await this.config.lcmBridge.flush();

    if (role.role === 'coder') {
      await this.runPostCoderGates(node, taskId);
    }

    return { output: { kind: 'string', value: outputForMemory } };
  }

  private async runPostCoderGates(node: DagNode, _taskId: ReturnType<typeof makeTaskId>): Promise<void> {
    // The CLI run path does not currently create per-task worktrees, so we read
    // the working-tree diff against HEAD via git instead of WorktreeManager.harvest.
    let diff = '';
    try {
      const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: this.config.cwd, maxBuffer: 8 * 1024 * 1024 });
      diff = stdout;
    } catch {
      return;
    }
    if (!diff.trim()) return;

    const securityGate = this.config.securityGate;
    if (!securityGate) return;

    const secRes = await securityGate.reviewDiff(diff);
    this.config.attestor.recordSecurityFindings(node.id, secRes);

    if (!secRes.passed) {
      await this.config.graph.addNode({
        kind:       'Failure',
        label:      `security:${node.id}`,
        properties: {
          nodeId:   node.id,
          findings: JSON.stringify(secRes.findings),
          summary:  secRes.summary,
        },
        runId: this.config.runId,
      });
      const blockingCount = secRes.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
      throw new Error(`Security review failed: ${blockingCount} blocking finding(s)`);
    }
  }
}

// Re-exported for callers that build DAG nodes inline without the planner.
export const DEFAULT_NODE_RETRY: RetryPolicy = {
  maxAttempts: 3, backoffMs: 1000, backoffFactor: 2, jitterMs: 500,
};
