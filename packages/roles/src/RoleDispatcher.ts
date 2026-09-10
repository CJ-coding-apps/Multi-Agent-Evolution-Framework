import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DagNode, RunId, RetryPolicy, BlackboardValue, CliAdapter, AdapterInvokeOptions,
} from '@maf/types';
import { isTurnAdapter, makeTaskId } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { Attestor } from '@maf/attestation';
import type { MemoryGraph } from '@maf/memory-graph';
import type { TranscriptLogger } from '@maf/transcript';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { ReviewGate, SecurityReviewGate } from '@maf/git-ops';
import type { HarnessConfig } from '@maf/harness-config';
import {
  ProcessorPipeline, createDefaultProcessorRegistry, DEFAULT_BUNDLE_REFS,
} from '@maf/processors';
import type { ProcessorDeps } from '@maf/processors';
import { InProcessAgentLoop } from '@maf/tool-loop';
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
  /** Pinned sampling temperature (e.g. 0 for golden determinism); forwarded to the adapter. */
  temperature?:   number;
  /** Phase 1: the resolved harness for this run (processor bundles live here). */
  harness?:       HarnessConfig;
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
    if (this.config.temperature !== undefined) invokeOpts.temperature = this.config.temperature;

    // ── Phase 1 gate: in-process roles go through the processor pipeline loop ──
    // Requires BOTH a sendTurn implementation AND the inProcessLoop capability:
    // an adapter may ship sendTurn but keep the capability off (e.g. Codex, whose
    // autonomous mode would bypass the gate) — that adapter must stay on CLI.
    const wantsInProcess = (role.execution ?? 'cli') === 'in-process';
    const adapter = this.config.adapter;
    const canInProcess = isTurnAdapter(adapter) && adapter.capabilities().inProcessLoop;
    if (wantsInProcess && !canInProcess) {
      await this.config.transcript.append(
        'system',
        `[warn] role "${role.role}" requested execution=in-process but adapter "${adapter.name}" lacks the capability; falling back to CLI dispatch`,
        { agentRole: role.role, nodeId: node.id },
      );
    }

    let outputForMemory: string;
    const ranInProcess = wantsInProcess && canInProcess;
    if (ranInProcess) {
      outputForMemory = await this.runInProcess(node, role, invokeOpts, taskId);
    } else {
      const result = await adapter.invoke(invokeOpts);
      outputForMemory = result.output.slice(0, MAX_STORED_OUTPUT_CHARS);
    }

    await this.config.transcript.append('assistant', outputForMemory, { agentRole: role.role, nodeId: node.id });
    await this.config.lcmBridge.flush();

    if (role.role === 'coder' && !ranInProcess) {
      // In-process coder runs the security gate at task_end via SecurityGateProcessor;
      // CLI path (including adapter-capability fallback) runs it here.
      await this.runPostCoderGates(node, taskId);
    }

    return { output: { kind: 'string', value: outputForMemory } };
  }

  /**
   * In-process execution: processor pipeline around every turn/tool call, policy
   * gated per call. Processor bundle = harness.processorBundles, or the default
   * bundle when the harness carries none (documented in HARNESSX_INTEGRATION_PLAN §4.3).
   */
  private async runInProcess(
    node: DagNode,
    role: ReturnType<RoleRegistry['getRole']>,
    invokeOpts: AdapterInvokeOptions,
    taskId: ReturnType<typeof makeTaskId>,
  ): Promise<string> {
    const adapter = this.config.adapter;
    if (!isTurnAdapter(adapter)) throw new Error('unreachable: gated by caller');

    const harness = this.config.harness;
    const refs = harness && harness.processorBundles.length > 0
      ? harness.processorBundles
      : [...DEFAULT_BUNDLE_REFS];
    const deps: ProcessorDeps = {
      transcript: this.config.transcript,
      securityRunner: () => this.runPostCoderGates(node, taskId),
    };
    const pipeline = ProcessorPipeline.build(refs, createDefaultProcessorRegistry(), deps);

    const toolList = new RoleToolRegistry(this.config.baseTools, role.allowedTools).getAll();
    const loop = new InProcessAgentLoop(
      {
        role:         role.role,
        harnessSha:   harness?.sha ?? '0'.repeat(64),
        systemPrompt: invokeOpts.systemPrompt ?? '',
        userPrompt:   invokeOpts.prompt,
        tools:        toolList,
        maxTurns:     role.maxToolIterations ?? 10,
        timeoutMs:    invokeOpts.timeoutMs,
        workingDir:   invokeOpts.workingDir,
        projectRoot:  this.config.cwd,
        sessionId:    this.config.sessionId,
        ...(invokeOpts.maxOutputBytes !== undefined ? { maxOutputBytes: invokeOpts.maxOutputBytes } : {}),
        ...(invokeOpts.tokenBudget !== undefined ? { tokenBudget: invokeOpts.tokenBudget } : {}),
        ...(invokeOpts.model !== undefined ? { model: invokeOpts.model } : {}),
      },
      {
        adapter,
        policy:    this.config.policy,
        attestor:  this.config.attestor,
        runId:     this.config.runId,
        taskId,
        pipeline,
      },
    );

    const result = await loop.run();
    if (result.outcome === 'failed') {
      throw new Error(`in-process role "${role.role}" failed: ${result.error ?? 'unknown'}`);
    }
    return result.finalText.slice(0, MAX_STORED_OUTPUT_CHARS);
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
