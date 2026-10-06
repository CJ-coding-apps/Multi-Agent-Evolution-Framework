import path from 'node:path';
import crypto from 'node:crypto';
import type { Command } from 'commander';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine } from '@maf/lcm';
import { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { MemoryGraph } from '@maf/memory-graph';
import { Attestor } from '@maf/attestation';
import { PolicyEngine } from '@maf/policy-engine';
import { RollbackManager, SecurityReviewGate } from '@maf/git-ops';
import { DagRunner } from '@maf/dag-runner';
import { GraphAwareInjector } from '@maf/prompt-injector';
import { RetrievalAugmentedPlanner } from '@maf/planning-agent';
import { TranscriptLogger } from '@maf/transcript';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry, RoleDispatcher } from '@maf/roles';
import { roleSetFromHarness } from '@maf/roles';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';

const SECURITY_REVIEW_FALLBACK_PROMPT = `You are a security auditor. Review the supplied diff for vulnerabilities. Respond with a strict JSON block:
{
  "findings": [
    { "severity": "critical|high|medium|low|info", "category": "short tag", "file": "path", "line": 0, "rationale": "...", "remediation": "..." }
  ],
  "summary": "one paragraph",
  "passed": true
}
"passed" must be false if any critical or high severity finding exists.`;

export function registerRunCommand(program: Command): void {
  program
    .command('run <task>')
    .description('Run a task using the MAF agent framework')
    .option('-a, --adapter <name>', 'CLI adapter to use (claude|gemini|codex|ollama|openrouter)', 'claude')
    .option('-m, --model <model>', 'Model name (adapter-specific)')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--no-worktree', 'Disable git worktree isolation')
    .option('--policy <path>', 'Path to policy YAML file', '.maf/policy.yaml')
    .option('--roles <path>', 'Path to roles YAML file', '.maf/roles.yaml')
    .option('--harness <ref>', 'Harness id, sha, or "current" (overrides --roles)')
    .action(async (taskDescription: string, opts: { adapter: string; model?: string; dir: string; worktree: boolean; policy: string; roles: string; harness?: string }) => {
      const cwd         = path.resolve(opts.dir);
      const mafDir      = path.join(cwd, '.maf');
      const runId       = makeRunId(crypto.randomUUID());
      const taskId      = makeTaskId(crypto.randomUUID());
      const sessionId   = runId;

      console.log(`[maf] run ${runId} | adapter: ${opts.adapter} | task: ${taskDescription}`);

      // Wire all components
      const board     = new BlackboardStore();
      const lcm       = new LcmEngine({
        dbPath:           path.join(mafDir, 'lcm.db'),
        contextThreshold: 0.75,
        freshTailCount:   64,
        mode:             'Upward',
        summarize: async (messages) => messages.map((m) => m.content.slice(0, 200)).join('\n'),
      });
      const graph     = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
      // Attestor constructed after harness resolution (harnessSha stamps ToolInvocation
      // nodes); created in two steps below.
      const policy    = await PolicyEngine.fromYaml(path.resolve(cwd, opts.policy), graph);
      const rollback  = new RollbackManager(cwd);
      const transcript = new TranscriptLogger(runId, makeAgentId(taskId), {
        logDir: path.join(mafDir, 'transcripts'),
        softThreshold: 20_000,
        chunkSize: 20,
        lcm,
      });

      await transcript.init();
      const lcmBridge = new BlackboardToLcmAdapter(board, lcm, sessionId, runId);

      const adapterRegistry = createAdapterRegistry();
      const adapter = await resolveAdapter(opts.adapter, adapterRegistry);

      const baseTools = createDefaultRegistry();

      // ── Harness resolution (Phase 0): --harness loads a stored config; otherwise the
      // legacy --roles file is parsed as today and wrapped as "legacy-default" (idempotent).
      const harnessStore = new HarnessStore(mafDir);
      let harness: HarnessConfig;
      let roles: RoleRegistry;
      if (opts.harness) {
        harness = await harnessStore.load(opts.harness);
        roles = RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), mafDir, baseTools);
        console.log(`[maf] harness: ${harness.id} (${shortSha(harness.sha)})`);
      } else {
        const legacyRegistry = await RoleRegistry.fromYamlOrDefault(
          path.resolve(cwd, opts.roles),
          mafDir,
          baseTools,
        );
        const legacyRoleSet = {
          version: 1 as const,
          defaultRole: legacyRegistry.getDefault().role,
          roles: legacyRegistry.list(),
        };
        harness = await harnessStore.adoptLegacy(legacyRoleSet);
        roles = legacyRegistry;
      }
      const attestor = new Attestor(runId, graph, path.join(mafDir, 'attestations'), undefined, harness.sha);

      // `security` may or may not be one of this set's roles; `resolve` answers that without
      // minting the name. The old `hasRole` + `getRole` pair asked twice, and `getRole` answered
      // an unrecognised name with the *default* role — so a role set without `security` would
      // have handed the writer's prompt to the security gate.
      const securityResolved = roles.resolve('security');
      const securityRole = securityResolved.ok ? securityResolved.value.config : undefined;
      const securityPrompt = securityRole
        ? (await roles.loadPrompt(securityRole))
        : SECURITY_REVIEW_FALLBACK_PROMPT;
      const securityGate = new SecurityReviewGate({
        adapter,
        projectRoot:    cwd,
        securityPrompt,
        ...(opts.model ? { model: opts.model } : {}),
      });

      const injector = new GraphAwareInjector({ graph, lcm, maxNodes: 40, tokenBudget: 4096 });
      const planner  = new RetrievalAugmentedPlanner({
        graph, lcm, injector,
        // The registry is the role set in force: it supplies the default role AND the answer to
        // "is this name real?". The planner used to carry `defaultRole` plus a `validRoles` set
        // and *warn* before assigning the default, which was the writer.
        roles,
        roleCatalog: roles.catalog(),
        generatePlan: async (systemPrompt, userPrompt) => {
          const result = await adapter.invoke({
            prompt: userPrompt, systemPrompt,
            workingDir: cwd, timeoutMs: 120_000,
            maxOutputBytes: 64 * 1024, // planning only needs a JSON block
            ...(opts.model ? { model: opts.model } : {}),
          });
          return result.output;
        },
      });

      const dispatcher = new RoleDispatcher({
        adapter,
        baseTools,
        roles,
        injector,
        policy,
        attestor,
        graph,
        transcript,
        lcmBridge,
        securityGate,
        cwd,
        sessionId,
        runId,
        harness,
        ...(opts.model ? { modelOverride: opts.model } : {}),
      });

      // Record run start in memory graph (harness provenance)
      await graph.addNode({
        kind: 'Run', label: runId,
        properties: { taskDescription, adapter: opts.adapter, harnessId: harness.id, harness_sha: harness.sha },
        runId,
      });

      // Generate DAG
      console.log('[maf] planning...');
      const dag = await planner.plan({ title: taskDescription, description: taskDescription, runId, sessionId });

      // Run DAG
      const dagRunner = new DagRunner();
      console.log(`[maf] running DAG with ${dag.nodes.size} node(s)...`);

      const outcome = await dagRunner.run({
        dag,
        board,
        executor: (node) => dispatcher.runNode(node),
        // The scheduler serializes writers against each other because two agents editing one
        // tree corrupt it. Deciding that from the role config — rather than treating every
        // node as a writer — is what lets two readers overlap; treating a reader as a writer
        // only costs concurrency, but treating a writer as a reader costs the tree.
        isWriter: (node) => roles.writesToWorkingTree(node.agentRole, baseTools),
        onNodeStart: (id) => console.log(`[maf] → node ${id} started`),
        onNodeEnd:   (id, status) => console.log(`[maf] ← node ${id} ${status}`),
      });

      // Every failed node leaves a Failure node behind. Until now only the security
      // gate wrote one, so no other kind of failure left a trace in the graph.
      for (const node of outcome.nodes ?? []) {
        if (node.status !== 'Failed') continue;
        await graph.addNode({
          kind:       'Failure',
          label:      node.nodeId,
          properties: {
            nodeId: node.nodeId,
            role:   dag.nodes.get(node.nodeId)?.agentRole ?? 'unknown',
            error:  node.error ?? 'unknown',
          },
          runId,
        });
      }

      // Bundle attestation — the harness IS the build's config source (signed):
      // configSource.uri points at the on-disk harness file, digest is its sha.
      const bundle = await attestor.bundle(
        { id: `@maf/adapter-${opts.adapter}@0.1.0`, modelVersion: opts.model ?? 'default' },
        {
          configSource: {
            uri:    path.join(mafDir, 'harnesses', `${harness.sha}.yaml`),
            digest: { sha256: harness.sha },
          },
          parameters:  { harnessId: harness.id },
          environment: {},
        },
        [],
        outcome,
      );

      console.log(`[maf] done. Attestation: ${path.join(mafDir, 'attestations', runId + '.bundle.json')}`);
      console.log(`[maf] signature: ${bundle.signature.slice(0, 16)}...`);

      // The bundle is written first so the failed run is still attested; the exit
      // code is what callers and CI actually branch on.
      if (outcome.status !== 'Succeeded') {
        const failed = (outcome.nodes ?? [])
          .filter((n) => n.status === 'Failed')
          .map((n) => n.nodeId);
        throw new Error(
          `run did not succeed (${outcome.status})` +
          ` — failed: [${failed.join(', ')}], never ran: [${outcome.unscheduled.join(', ')}]`,
        );
      }

      graph.close();
      lcm.close();
    });
}
