import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeAgentId, makeNodeId, makeTaskId } from '@maf/types';
import type { DagNode, CliAdapter, RunId } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine } from '@maf/lcm';
import { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { MemoryGraph } from '@maf/memory-graph';
import { Attestor } from '@maf/attestation';
import { PolicyEngine } from '@maf/policy-engine';
import { SecurityReviewGate } from '@maf/git-ops';
import { GraphAwareInjector } from '@maf/prompt-injector';
import { TranscriptLogger } from '@maf/transcript';
import { createDefaultRegistry } from '@maf/tools';
import { RoleDispatcher, RoleRegistry, roleSetFromHarness } from '@maf/roles';
import type { HarnessConfig } from '@maf/harness-config';
import type { TaskDispatcher } from '@maf/eval-harness';

/**
 * Shared CLI wiring for run/goldens/evolve commands: one component stack per
 * invocation, one TaskDispatcher factory producing isolated RoleDispatchers.
 * Keep component construction here, nowhere else (single home per §5).
 */

export const SECURITY_REVIEW_FALLBACK_PROMPT = `You are a security auditor. Review the supplied diff for vulnerabilities. Respond with a strict JSON block:
{ "findings": [ { "severity": "critical|high|medium|low|info", "category": "t", "file": "f", "line": 0, "rationale": "r", "remediation": "x" } ], "summary": "s", "passed": true }`;

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluation judge. You are given a RUBRIC and a SUBJECT (an agent's output).
Decide whether the subject satisfies the rubric. Respond with ONLY a fenced JSON block:
\`\`\`json
{ "passed": true, "rationale": "one concise sentence" }
\`\`\`
Be conservative: if the subject does not clearly meet the rubric, "passed" is false.`;

/** Extract {passed, rationale} from a judge model response (fenced JSON or bare). */
export function parseJudgeVerdict(output: string): { passed: boolean; rationale: string } {
  const m = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(output);
  const candidate = m ? m[1]! : output.trim();
  try {
    const parsed = JSON.parse(candidate) as { passed?: unknown; rationale?: unknown };
    return {
      passed: parsed.passed === true,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch {
    return { passed: false, rationale: 'unparseable judge response — fail closed' };
  }
}

export interface RunStack {
  adapter: CliAdapter;
  graph: MemoryGraph;
  attestor: Attestor;
  lcm: LcmEngine;
  securityPrompt: string;
  rolesFor(harness: HarnessConfig): RoleRegistry;
  dispatchTask(harness: HarnessConfig, role: string, prompt: string, workDir: string, timeoutMs: number, temperature?: number): Promise<string>;
  /** LLM judge for llm-judge verifiers (M4): rubric + subject → pass/fail. */
  judge(rubric: string, subject: string): Promise<{ passed: boolean; rationale: string }>;
  close(): void;
}

export async function buildRunStack(cfg: {
  cwd: string;
  mafDir: string;
  policyPath: string;
  adapter: CliAdapter;
  model?: string;
  runId: RunId;
  harnessSha: string;
}): Promise<RunStack> {
  const graph = new MemoryGraph(path.join(cfg.mafDir, 'memory.kuzu'));
  const attestor = new Attestor(cfg.runId, graph, path.join(cfg.mafDir, 'attestations'), undefined, cfg.harnessSha);
  const policy = await PolicyEngine.fromYaml(cfg.policyPath, graph);
  const baseTools = createDefaultRegistry();
  const board = new BlackboardStore();
  const lcm = new LcmEngine({
    dbPath: path.join(cfg.mafDir, 'lcm.db'),
    contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
    summarize: async (msgs) => msgs.map((m) => m.content.slice(0, 200)).join('\n'),
  });
  const injector = new GraphAwareInjector({ graph, lcm, maxNodes: 40, tokenBudget: 4096 });
  const lcmBridge = new BlackboardToLcmAdapter(board, lcm, cfg.runId, cfg.runId);

  const stack: RunStack = {
    adapter: cfg.adapter,
    graph,
    attestor,
    lcm,
    securityPrompt: SECURITY_REVIEW_FALLBACK_PROMPT,
    rolesFor: (harness) => RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), cfg.mafDir, baseTools),
    async dispatchTask(harness, role, prompt, workDir, timeoutMs, temperature) {
      const taskId = makeTaskId(crypto.randomUUID());
      const transcript = new TranscriptLogger(cfg.runId, makeAgentId(taskId), {
        logDir: path.join(cfg.mafDir, 'transcripts'), softThreshold: 20_000, chunkSize: 20, lcm,
      });
      await transcript.init();
      const gate = new SecurityReviewGate({
        adapter: cfg.adapter, projectRoot: workDir, securityPrompt: stack.securityPrompt,
        ...(cfg.model ? { model: cfg.model } : {}),
      });
      const dispatcher = new RoleDispatcher({
        adapter: cfg.adapter, baseTools, roles: stack.rolesFor(harness), injector, policy,
        attestor, graph, transcript, lcmBridge, securityGate: gate,
        cwd: workDir, sessionId: cfg.runId, runId: cfg.runId, harness,
        ...(cfg.model ? { modelOverride: cfg.model } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      });
      const node: DagNode = {
        id: makeNodeId(`evolve-${taskId}`), label: prompt, agentRole: role,
        dependencies: [], retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
        timeoutMs, inputs: {}, outputs: {}, metadata: { taskDescription: prompt },
      };
      const out = await dispatcher.runNode(node);
      const value = out['output'];
      return value && value.kind === 'string' ? value.value : '';
    },
    async judge(rubric, subject) {
      const result = await cfg.adapter.invoke({
        prompt: `RUBRIC:\n${rubric}\n\nSUBJECT:\n${subject}`,
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        workingDir: cfg.cwd, timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
        temperature: 0,
        ...(cfg.model ? { model: cfg.model } : {}),
      });
      return parseJudgeVerdict(result.output);
    },
    close() {
      graph.close();
      lcm.close();
    },
  };
  return stack;
}

/**
 * Resolve the golden corpus root (L6). Prefers the requested path; if it has no
 * corpus.json, falls back to the repo's committed seed corpus at tests/goldens
 * (which holds corpus.json AND rubrics/, so rubricFile resolution still works).
 */
export async function resolveCorpusRoot(cwd: string, optPath: string): Promise<string> {
  const primary = path.resolve(cwd, optPath);
  try {
    await readFile(path.join(primary, 'corpus.json'), 'utf8');
    return primary;
  } catch { /* fall through to the seed corpus */ }
  const fallback = path.resolve(cwd, 'tests', 'goldens');
  try {
    await readFile(path.join(fallback, 'corpus.json'), 'utf8');
    console.log(`[maf] corpus not found at ${primary}; using seed corpus at ${fallback}`);
    return fallback;
  } catch {
    return primary; // let the caller's own read surface a clear error for the requested path
  }
}

export { type TaskDispatcher };
