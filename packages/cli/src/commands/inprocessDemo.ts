import crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { makeRunId } from '@maf/types';
import type { CliAdapter } from '@maf/types';
import { mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { buildTurnSystemPrompt } from '@maf/adapter-base';
import { componentId } from '@maf/attestation';
import { ScriptedAdapter } from '@maf/eval-harness';
import { runIsolatedGit } from '@maf/git-ops';
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
 * The deterministic stand-in for the model walks this script, one tool call per turn:
 *   1. fs.read config.txt   (shows redaction of the result the model sees)
 *   2. fs.delete sum.js      (escalated; no one can approve it headless, so it is refused and recorded)
 *   3. fs.write sum.js fix   (real file effect)
 *   4. test.run              (real execution)
 *   5. finish (no tool calls)
 */
const DEMO_SCRIPT = {
  prompt: CODER_PROMPT,
  steps: [
    { tool: 'fs.read', input: { path: 'config.txt' } },
    { tool: 'fs.delete', input: { path: 'sum.js' } },          // escalated, refused headless
    { tool: 'fs.write', input: { path: 'sum.js', content: SUM_FIXED } },
    { tool: 'test.run', input: {} },
  ],
  final: 'Fixed sum.js (a - b → a + b); tests pass.',
};

/**
 * Writes the demo's buggy repository under `<tmpDir>/repo` and commits it as the baseline;
 * returns the repository path.
 *
 * The git calls go through `runIsolatedGit` because the fixture is maf's, not the user's:
 * a global `commit.gpgsign`, `core.hooksPath` or template dir made the baseline commit fail
 * (or run the user's hooks) depending on whose machine the demo ran on. `commit.gpgsign` is
 * also pinned on the command line, as the golden runner does, since `-c` beats any config
 * that still reaches git through the environment.
 */
export async function createDemoFixture(tmpDir: string): Promise<string> {
  const dir = path.join(tmpDir, 'repo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2), 'utf8');
  await writeFile(path.join(dir, 'sum.js'), SUM_BUGGY, 'utf8');
  await writeFile(path.join(dir, 'test.js'), TEST_JS, 'utf8');
  await writeFile(path.join(dir, 'config.txt'), CONFIG_WITH_SECRET, 'utf8');
  const git = (args: string[]) => runIsolatedGit(dir, args);
  await git(['init', '-q']);
  await git(['config', 'user.email', 'demo@maf.local']);
  await git(['config', 'user.name', 'maf-demo']);
  await git(['add', '-A']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline (buggy sum)']);
  return dir;
}

async function makeFixture(): Promise<string> {
  return createDemoFixture(await mkdtemp(path.join(tmpdir(), 'maf-inproc-')));
}

/**
 * What the demo printed it showed. The redaction and gate lines are checked only offline, where the
 * scripted model is known to have asked for them; `undefined` there means "not checked".
 */
export interface DemoObservation {
  sumFixed:      boolean;
  testPassed:    boolean;
  redacted?:     boolean;
  faithful?:     boolean;
  policyDenied?: boolean;
}

/**
 * Each claim the demo's result block makes that did not hold. The exit status is these, all of
 * them: the redaction and gate lines used to be printed and never checked, so a demo whose model
 * saw the key, or whose delete went through, still exited 0.
 */
export function demoFailures(o: DemoObservation): string[] {
  const failed: string[] = [];
  if (!o.sumFixed)              failed.push('the in-process coder did not fix sum.js');
  if (!o.testPassed)            failed.push('the tests did not pass');
  if (o.redacted === false)     failed.push('the model saw an fs.read result with no credential redacted');
  if (o.faithful === false)     failed.push('redaction did not keep the lines around the credential as they were');
  if (o.policyDenied === false) failed.push('the escalated fs.delete was not refused in the loop');
  return failed;
}

/**
 * Writes the demo's bundle, then closes its stack. A bundle that cannot be written fails the demo —
 * its result block names the bundle as the proof — so the error is not swallowed. A dispatch that
 * already failed is still attested, and its error, the cause, is the one thrown.
 */
export async function attestAndClose(stack: { close(): void }, attest: () => Promise<unknown>, dispatchError?: unknown): Promise<void> {
  try {
    await attest();
  } catch (err) {
    if (dispatchError === undefined) throw err;
    console.error(`[demo] the attestation bundle could not be written either: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    stack.close();
  }
  if (dispatchError !== undefined) throw dispatchError;
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
      // Policy: fs.delete needs a human's approval, allow the rest. The demo runs headless, so the
      // scripted delete is refused without a prompt, and the refusal lands in the bundle's approvals.
      const policyPath = path.join(mafDir, 'policy.yaml');
      await writeFile(policyPath, JSON.stringify({
        rules: [{
          id: 'delete-needs-a-human', description: 'a file is deleted only with a human\'s approval',
          predicate: { toolId: 'fs.delete' },
          action: { kind: 'Escalate', requiresApproval: true },
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

      const scripted = new ScriptedAdapter([DEMO_SCRIPT]);
      const adapter: CliAdapter = opts.live
        ? await resolveAdapter('claude', createAdapterRegistry())
        : scripted;

      const runId = makeRunId(crypto.randomUUID());
      console.log(`[demo] fixture:  ${fixture}`);
      console.log(`[demo] adapter:  ${adapter.name} (inProcessLoop=${adapter.capabilities().inProcessLoop})`);
      console.log(`[demo] run:      ${runId}`);

      // Headless whatever the terminal, so the demo runs the same offline, unattended and in CI (D-02).
      const stack = await buildRunStack({ cwd: fixture, mafDir, policyPath, adapter, runId, harnessSha: harness.sha, headless: true });

      let output = '';
      let dispatchError: unknown;
      try {
        output = await stack.dispatchTask(harness, 'coder', CODER_PROMPT, fixture, 120_000, 0);
      } catch (err) {
        dispatchError = err;
      }
      // A signed attestation bundle for the run, whatever happened (records are redacted at record-time).
      await attestAndClose(stack, () => stack.attestor.bundle(
        { id: componentId('@maf/inprocess-demo'), modelVersion: adapter.name },
        { configSource: { uri: 'inprocess-demo', digest: { sha256: harness.sha } }, parameters: { harnessId: harness.id }, environment: {} },
        [],
        { status: dispatchError === undefined ? 'Succeeded' : 'Failed', unscheduled: [] },
      ), dispatchError);

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
      const observed: DemoObservation = { sumFixed: sumAfter.trim() === SUM_FIXED.trim(), testPassed };
      if (!opts.live) {
        // The system block exactly as a real TurnAdapter composes it from what the loop handed
        // the model, so the line shows the tool catalog (by id) the model saw (H1).
        const turns = scripted.exchanges.filter((e) => e.via === 'turn');
        const firstTurn = turns[0];
        const shownPrompt = firstTurn ? buildTurnSystemPrompt(firstTurn.systemPrompt, firstTurn.tools) : '';
        const catalogLine = shownPrompt.split('\n').find((l) => l.includes('fs.write')) ?? '(not found)';
        console.log(`H1   model saw the tool catalog (by id):    ${catalogLine.trim()}`);
        const toolResultsSeen = turns.flatMap((e) => (e.lastToolResult !== undefined ? [e.lastToolResult] : []));
        const redacted = toolResultsSeen.find((r) => r.includes('REDACTED')) ?? '(none)';
        observed.redacted = redacted !== '(none)';
        observed.faithful = redacted.includes('db_host=localhost') && redacted.includes('port=5432');
        observed.policyDenied = toolResultsSeen.some((r) => /policy|not permitted|Deny/i.test(r));
        console.log(`L1   model's fs.read result redacted:       ${JSON.stringify(redacted)}`);
        console.log(`     └─ surrounding lines kept faithful:    ${observed.faithful}`);
        console.log(`gate policy blocked fs.delete in-loop:      ${observed.policyDenied}`);
      }
      console.log(`tools sum.js fixed (a - b → a + b):         ${observed.sumFixed}`);
      console.log(`exec npm test result:                       ${testPassed ? 'PASS' : 'FAIL'}  (${testOut.trim().split('\n').pop()})`);
      console.log(`attn signed bundle:                         ${path.join(mafDir, 'attestations', runId + '.bundle.json')}`);
      console.log(`loop final assistant text:                  ${JSON.stringify(output)}`);
      console.log('───────────────────────────────────');

      const failures = demoFailures(observed);
      if (failures.length > 0) {
        console.error(`[demo] FAILED: ${failures.join('; ')}`);
        process.exitCode = 1;
      } else {
        console.log('[demo] OK: in-process role ran end-to-end (tools gated, executed, attested).');
      }
    });
}
