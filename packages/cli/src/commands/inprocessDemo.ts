import crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { makeRunId } from '@maf/types';
import type {
  CliAdapter, TurnAdapter, TurnMessage, AssistantTurn,
  AdapterInvokeOptions, AdapterInvokeResult, AdapterCapabilities, ToolCallRecord,
} from '@maf/types';
import { mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { buildTurnSystemPrompt } from '@maf/adapter-base';
import { buildRunStack } from '../wiring.js';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';

/**
 * End-to-end demonstration of a role running IN-PROCESS: the gated processor
 * pipeline loop (not the opaque CLI invoke). It stands up the real component
 * stack (tools, PolicyEngine, Attestor, SecurityReviewGate, default processor
 * bundle) in a throwaway fixture repo and drives one coder node through
 * RoleDispatcher.runNode with execution: 'in-process'.
 *
 * Default model is a deterministic ScriptedAdapter so the demo is reproducible
 * offline; `--live` uses the real `claude` adapter instead.
 */

const SUM_BUGGY = 'module.exports = (a, b) => a - b;\n';
const SUM_FIXED = 'module.exports = (a, b) => a + b;\n';
const TEST_JS =
  "const sum = require('./sum');\n" +
  "if (sum(2, 3) !== 5) { console.error('FAIL: sum(2,3) =', sum(2, 3)); process.exit(1); }\n" +
  "console.log('PASS');\n";
const CONFIG_WITH_SECRET = 'db_host=localhost\napi_key=AKIAIOSFODNN7EXAMPLE\nport=5432\n';

const CODER_PROMPT =
  'You are a coder. A failing test indicates a bug in sum.js. Read the files you need, ' +
  'fix the source so the test passes, then run the tests. Use only the provided tools.';

/**
 * Deterministic stand-in for the model. Picks its action by how many tool
 * results are already in the history, so it walks a fixed script:
 *   1. fs.read config.txt   (shows redaction of the result the model sees)
 *   2. fs.delete sum.js      (blocked by policy — demonstrates the gate)
 *   3. fs.write sum.js fix   (real file effect)
 *   4. test.run              (real execution)
 *   5. finish (no tool calls)
 */
class ScriptedCoderAdapter implements TurnAdapter {
  readonly name = 'scripted';
  capturedSystemPrompt = '';
  toolResultsSeen: string[] = [];

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
      inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }
  async isAvailable(): Promise<boolean> { return true; }

  // Used by SecurityReviewGate at task_end — report a clean diff.
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return {
      success: true,
      output: '{"findings":[],"summary":"no issues in demo diff","passed":true}',
      toolCallLog: [], exitCode: 0, duration: 1,
    };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield ''; }

  async sendTurn(history: TurnMessage[], opts: AdapterInvokeOptions): Promise<AssistantTurn> {
    // Compose the system block exactly as a real TurnAdapter does, so the
    // captured prompt reflects the tool catalog (by id) the loop handed us (H1).
    if (!this.capturedSystemPrompt) this.capturedSystemPrompt = buildTurnSystemPrompt(opts.systemPrompt, opts.tools);
    const toolMsgs = history.filter((m) => m.kind === 'tool');
    const last = toolMsgs[toolMsgs.length - 1];
    if (last && last.kind === 'tool') this.toolResultsSeen.push(last.content);

    const call = (toolName: string, input: Record<string, unknown>): AssistantTurn => ({
      text: `step ${toolMsgs.length + 1}`,
      toolCalls: [{ toolUseId: crypto.randomUUID(), toolName, input }],
    });

    switch (toolMsgs.length) {
      case 0: return call('fs.read', { path: 'config.txt' });
      case 1: return call('fs.delete', { path: 'sum.js' });          // policy denies
      case 2: return call('fs.write', { path: 'sum.js', content: SUM_FIXED });
      case 3: return call('test.run', {});
      default: return { text: 'Fixed sum.js (a - b → a + b); tests pass.', toolCalls: [] };
    }
  }
}

async function makeFixture(): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'maf-inproc-')), 'repo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2), 'utf8');
  await writeFile(path.join(dir, 'sum.js'), SUM_BUGGY, 'utf8');
  await writeFile(path.join(dir, 'test.js'), TEST_JS, 'utf8');
  await writeFile(path.join(dir, 'config.txt'), CONFIG_WITH_SECRET, 'utf8');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'demo@maf.local']);
  git(['config', 'user.name', 'maf-demo']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'baseline (buggy sum)']);
  return dir;
}

export function registerInProcessDemoCommand(program: Command): void {
  program
    .command('inprocess-demo')
    .description('Run a coder role end-to-end through the in-process gated loop (real tools/policy/attestation)')
    .option('--live', 'Use the real `claude` adapter instead of the deterministic scripted model', false)
    .action(async (opts: { live: boolean }) => {
      const fixture = await makeFixture();
      const mafDir = path.join(fixture, '.maf');
      await mkdir(mafDir, { recursive: true });
      // Policy: deny fs.delete (so the scripted delete attempt is gated), allow the rest.
      const policyPath = path.join(mafDir, 'policy.yaml');
      await writeFile(policyPath, JSON.stringify({
        rules: [{
          id: 'no-delete', description: 'no file deletion in the demo',
          predicate: { toolId: 'fs.delete' },
          action: { kind: 'Deny', reason: 'file deletion is not permitted in this demo' },
          priority: 100,
        }],
      }, null, 2), 'utf8');

      const harness: HarnessConfig = mintHarnessConfig({
        id: 'inprocess-demo',
        roleSet: {
          version: 1, defaultRole: 'coder',
          roles: [{
            role: 'coder', description: 'fixes failing tests',
            systemPrompt: CODER_PROMPT,
            allowedTools: ['fs.read', 'fs.write', 'fs.delete', 'test.run'],
            execution: 'in-process',
          }],
        },
        processorBundles: [], // empty ⇒ RoleDispatcher uses the default bundle (incl. secret-redact + security-gate)
      });

      const scripted = new ScriptedCoderAdapter();
      const adapter: CliAdapter = opts.live
        ? await resolveAdapter('claude', createAdapterRegistry())
        : scripted;

      const runId = makeRunId(crypto.randomUUID());
      console.log(`[demo] fixture:  ${fixture}`);
      console.log(`[demo] adapter:  ${adapter.name} (inProcessLoop=${adapter.capabilities().inProcessLoop})`);
      console.log(`[demo] run:      ${runId}`);

      const stack = await buildRunStack({ cwd: fixture, mafDir, policyPath, adapter, runId, harnessSha: harness.sha });

      let output: string;
      try {
        output = await stack.dispatchTask(harness, 'coder', CODER_PROMPT, fixture, 120_000, 0);
      } finally {
        // produce a signed attestation bundle for the run (records are already redacted at record-time)
        await stack.attestor.bundle(
          { id: '@maf/inprocess-demo@0.1.0', modelVersion: adapter.name },
          { configSource: { uri: 'inprocess-demo', digest: { sha256: harness.sha } }, parameters: { harnessId: harness.id }, environment: {} },
          [],
        ).catch(() => undefined);
        stack.close();
      }

      // ── observe real effects ──
      const sumAfter = await readFile(path.join(fixture, 'sum.js'), 'utf8');
      let testPassed = false;
      let testOut = '';
      try {
        testOut = execFileSync('npm', ['test'], { cwd: fixture, stdio: 'pipe' }).toString();
        testPassed = /PASS/.test(testOut);
      } catch (e) {
        testOut = (e as { stdout?: Buffer }).stdout?.toString() ?? String(e);
      }

      console.log('\n──────── end-to-end result ────────');
      if (!opts.live) {
        const catalogLine = scripted.capturedSystemPrompt.split('\n').find((l) => l.includes('fs.write')) ?? '(not found)';
        console.log(`H1   model saw the tool catalog (by id):    ${catalogLine.trim()}`);
        const redacted = scripted.toolResultsSeen.find((r) => r.includes('REDACTED')) ?? '(none)';
        console.log(`L1   model's fs.read result redacted:       ${JSON.stringify(redacted)}`);
        console.log(`     └─ surrounding lines kept faithful:    ${redacted.includes('db_host=localhost') && redacted.includes('port=5432')}`);
        const policyDenied = scripted.toolResultsSeen.some((r) => /policy|not permitted|Deny/i.test(r));
        console.log(`gate policy blocked fs.delete in-loop:      ${policyDenied}`);
      }
      console.log(`tools sum.js fixed (a - b → a + b):         ${sumAfter.trim() === SUM_FIXED.trim()}`);
      console.log(`exec npm test result:                       ${testPassed ? 'PASS' : 'FAIL'}  (${testOut.trim().split('\n').pop()})`);
      console.log(`attn signed bundle:                         ${path.join(mafDir, 'attestations', runId + '.bundle.json')}`);
      console.log(`loop final assistant text:                  ${JSON.stringify(output)}`);
      console.log('───────────────────────────────────');

      if (!(sumAfter.trim() === SUM_FIXED.trim() && testPassed)) {
        console.error('[demo] FAILED: the in-process coder did not fix the code / tests did not pass');
        process.exitCode = 1;
      } else {
        console.log('[demo] OK: in-process role ran end-to-end (tools gated, executed, attested).');
      }
    });
}
