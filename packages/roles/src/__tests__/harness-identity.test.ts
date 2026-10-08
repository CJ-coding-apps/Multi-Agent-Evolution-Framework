import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CliAdapter, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AttestationBundle,
  DagNode, RoleName,
} from '@maf/types';
import { makeNodeId, makeRunId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { Attestor } from '@maf/attestation';
import { HarnessStore, mintHarnessConfig, resolveHarnessRef } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import type { TranscriptLogger } from '@maf/transcript';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { MemoryGraph } from '@maf/memory-graph';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { RoleDispatcher } from '../RoleDispatcher.js';
import { RoleRegistry, RoleConfigError } from '../RoleRegistry.js';
import { defineRoleName } from '../RoleConfig.js';
import { harnessRoleSetFromRegistry, roleSetFromHarness } from '../harnessBridge.js';

// ORACLE: the harness sha a run stamps identifies what it dispatched — roles.yaml AND the text of
// every prompt file it names — and the attestation's configSource.digest is that sha.

const BASE_TOOLS = createDefaultRegistry();
const ANALYST = defineRoleName('analyst');

/** A CLI-tier adapter that records the system prompt each call was handed. */
class PromptRecorder implements CliAdapter {
  readonly name = 'recorder';
  readonly systemPrompts: string[] = [];
  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
      inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.systemPrompts.push(o.systemPrompt ?? '');
    return { success: true, output: 'analysis', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(): AsyncGenerator<string> { yield 'x'; }
}

function rolesYaml(description: string): string {
  return JSON.stringify({
    version: 1,
    defaultRole: 'analyst',
    roles: [{ role: 'analyst', description, promptFile: 'prompts/analyst.md', allowedTools: ['fs.read'] }],
  });
}

async function withMafDir(fn: (mafDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-harness-identity-'));
  const mafDir = path.join(root, '.maf');
  await mkdir(path.join(mafDir, 'prompts'), { recursive: true });
  await writeFile(path.join(mafDir, 'roles.yaml'), rolesYaml('reads code'), 'utf8');
  await writeFile(path.join(mafDir, 'prompts', 'analyst.md'), 'You are the analyst, v1.', 'utf8');
  try {
    await fn(mafDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeNode(role: RoleName): DagNode {
  return {
    id: makeNodeId('n1'), label: 'look around', agentRole: role, dependencies: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
    timeoutMs: 30_000, inputs: {}, outputs: {}, metadata: { taskDescription: 'look around' },
  };
}

/**
 * What a plain `maf run` does with a harness, minus the planner: resolve it, build the role set
 * from the harness itself, dispatch one node, attest with the store's config source.
 */
async function plainRun(mafDir: string, runLabel: string, harnessFlag?: string) {
  const store = new HarnessStore(mafDir);
  const { harness } = await resolveHarnessRef({
    harness: harnessFlag,
    legacyRoleSet: async () => harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, BASE_TOOLS)),
  }, store);
  const roles = RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), mafDir, BASE_TOOLS);
  const adapter = new PromptRecorder();
  const runId = makeRunId(runLabel);
  const attestor = new Attestor(runId, {} as MemoryGraph, path.join(mafDir, 'attestations'), {}, harness.sha);
  const dispatcher = new RoleDispatcher({
    adapter,
    baseTools: BASE_TOOLS,
    roles,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as unknown as GraphAwareInjector,
    policy: {} as PolicyEngine,
    attestor,
    graph: {} as MemoryGraph,
    transcript: { append: async () => {} } as unknown as TranscriptLogger,
    lcmBridge: { flush: async () => {} } as unknown as BlackboardToLcmAdapter,
    cwd: path.dirname(mafDir),
    sessionId: runLabel,
    runId,
    harness,
  });
  await dispatcher.runNode(makeNode(ANALYST));
  const bundle: AttestationBundle = await attestor.bundle(
    { id: '@maf/adapter-recorder', modelVersion: 'default' },
    { configSource: await store.configSource(harness), parameters: { harnessId: harness.id }, environment: {} },
    [],
    { status: 'Succeeded', unscheduled: [] },
  );
  const dispatchedPrompt = adapter.systemPrompts[0];
  assert.equal(adapter.systemPrompts.length, 1);
  return { store, harness, bundle, dispatchedPrompt };
}

/** The prompt a harness — looked up by the digest an attestation names — hands the analyst. */
async function promptNamedBy(store: HarnessStore, digest: string, mafDir: string): Promise<string> {
  const named = await store.load(digest);
  const roles = RoleRegistry.fromSet(roleSetFromHarness(named.roleSet), mafDir, BASE_TOOLS);
  return roles.loadPrompt(roles.getRole(ANALYST));
}

test('harnessRoleSetFromRegistry carries each prompt file\'s text, so editing the file changes the sha', async () => {
  await withMafDir(async (mafDir) => {
    const yamlPath = path.join(mafDir, 'roles.yaml');
    const v1 = await harnessRoleSetFromRegistry(await RoleRegistry.fromYamlOrDefault(yamlPath, mafDir, BASE_TOOLS));
    assert.equal(v1.roles[0]?.systemPrompt, 'You are the analyst, v1.');
    assert.equal(v1.roles[0]?.promptFile, 'prompts/analyst.md', 'the path is kept as provenance');

    await writeFile(path.join(mafDir, 'prompts', 'analyst.md'), 'You are the analyst, v2.', 'utf8');
    const v2 = await harnessRoleSetFromRegistry(await RoleRegistry.fromYamlOrDefault(yamlPath, mafDir, BASE_TOOLS));
    assert.equal(v2.roles[0]?.systemPrompt, 'You are the analyst, v2.');

    const sha = (roleSet: typeof v1) => mintHarnessConfig({ id: 'legacy-default', roleSet, processorBundles: [] }).sha;
    assert.notEqual(sha(v1), sha(v2));
  });
});

test('harnessRoleSetFromRegistry leaves inline prompts and prompt-less roles as they are', async () => {
  const roles = RoleRegistry.fromSet({
    version: 1,
    defaultRole: defineRoleName('a'),
    roles: [
      { role: defineRoleName('a'), systemPrompt: 'inline', allowedTools: [] },
      { role: defineRoleName('b'), allowedTools: [] },
    ],
  }, '/this-path-does-not-exist');
  const set = await harnessRoleSetFromRegistry(roles);
  assert.deepEqual(set, {
    version: 1,
    defaultRole: 'a',
    roles: [{ role: 'a', systemPrompt: 'inline', allowedTools: [] }, { role: 'b', allowedTools: [] }],
  });
});

test('harnessRoleSetFromRegistry refuses a role whose prompt file cannot be read, naming the role and the file', async () => {
  await withMafDir(async (mafDir) => {
    await rm(path.join(mafDir, 'prompts', 'analyst.md'));
    const registry = await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, BASE_TOOLS);
    await assert.rejects(
      () => harnessRoleSetFromRegistry(registry),
      (err: unknown) => err instanceof RoleConfigError
        && /Role "analyst" names prompt file "prompts\/analyst\.md", which could not be read/.test(err.message),
    );
  });
});

test('a plain run: the attestation digest is the dispatched harness, and editing a prompt file or roles.yaml changes it', async () => {
  await withMafDir(async (mafDir) => {
    const first = await plainRun(mafDir, 'run-1');
    const digest1 = first.bundle.provenance.invocation.configSource.digest.sha256;
    assert.equal(digest1, first.harness.sha);
    assert.equal(first.dispatchedPrompt, 'You are the analyst, v1.');
    assert.equal(await promptNamedBy(first.store, digest1, mafDir), first.dispatchedPrompt,
      'the harness the attestation names hands out exactly the prompt that was dispatched');

    // Edit only the prompt file.
    await writeFile(path.join(mafDir, 'prompts', 'analyst.md'), 'You are the analyst, v2.', 'utf8');
    const second = await plainRun(mafDir, 'run-2');
    const digest2 = second.bundle.provenance.invocation.configSource.digest.sha256;
    assert.equal(digest2, second.harness.sha);
    assert.notEqual(digest2, digest1);
    assert.equal(second.dispatchedPrompt, 'You are the analyst, v2.');
    assert.equal(await promptNamedBy(second.store, digest2, mafDir), second.dispatchedPrompt);
    // The first run's attestation still names a harness that says what that run dispatched.
    assert.equal(await promptNamedBy(second.store, digest1, mafDir), 'You are the analyst, v1.');

    // Edit only roles.yaml.
    await writeFile(path.join(mafDir, 'roles.yaml'), rolesYaml('reads code carefully'), 'utf8');
    const third = await plainRun(mafDir, 'run-3');
    const digest3 = third.bundle.provenance.invocation.configSource.digest.sha256;
    assert.equal(digest3, third.harness.sha);
    assert.notEqual(digest3, digest2);
    assert.equal(third.harness.roleSet.roles[0]?.description, 'reads code carefully');

    // The signed bundle on disk carries the same digest.
    const onDisk = JSON.parse(await readFile(path.join(mafDir, 'attestations', 'run-3.bundle.json'), 'utf8'));
    assert.equal(onDisk.provenance.invocation.configSource.digest.sha256, third.harness.sha);
  });
});

test('a pinned harness dispatches the prompt text it carries, whatever the prompt file says now', async () => {
  await withMafDir(async (mafDir) => {
    const first = await plainRun(mafDir, 'run-1');
    await writeFile(path.join(mafDir, 'prompts', 'analyst.md'), 'You are the analyst, v2.', 'utf8');
    const pinned = await plainRun(mafDir, 'run-2', first.harness.sha);
    assert.equal(pinned.harness.sha, first.harness.sha);
    assert.equal(pinned.dispatchedPrompt, 'You are the analyst, v1.');
  });
});

test('set-current changes what the next plain run dispatches', async () => {
  await withMafDir(async (mafDir) => {
    const store = new HarnessStore(mafDir);
    const chosen: HarnessConfig = mintHarnessConfig({
      id: 'chosen',
      roleSet: { version: 1, defaultRole: 'analyst', roles: [{ role: 'analyst', systemPrompt: 'chosen prompt', allowedTools: ['fs.read'] }] },
      processorBundles: [],
    });
    await store.save(chosen);
    await store.setCurrent((await store.load('chosen')).sha);
    const run = await plainRun(mafDir, 'run-1');
    assert.equal(run.harness.sha, chosen.sha);
    assert.equal(run.dispatchedPrompt, 'chosen prompt');
    assert.equal(run.bundle.provenance.invocation.configSource.digest.sha256, chosen.sha);
  });
});

test('loadPrompt: an empty inline prompt is the prompt; the prompt file beside it is not read', async () => {
  // A harness inlines a prompt file's text as systemPrompt and keeps the path. An empty file
  // inlines as '', and treating '' as "no prompt" would read the file again at dispatch — content
  // the sha does not cover.
  await withMafDir(async (mafDir) => {
    const roles = RoleRegistry.fromSet({
      version: 1,
      defaultRole: ANALYST,
      roles: [{ role: ANALYST, systemPrompt: '', promptFile: 'prompts/analyst.md', allowedTools: [] }],
    }, mafDir);
    assert.equal(await roles.loadPrompt(roles.getDefault()), '');
  });
});
