import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterInvokeOptions, TurnMessage } from '@maf/types';
import { CodexAdapter } from '../index.js';

// ORACLE (WP-3.9 F6, widened by round 2 G6): every `codex` maf spawns is given `backendEnv()` —
// everything except `MAF_*` — at each of the three places this adapter spawns it: a cli-tier
// `invoke`, a governed `sendTurn`, and the `--version` question `isAvailable` asks. Until these
// tests nothing proved it at the adapter, and reverting any one spawn to `{ ...process.env }`
// passed the whole suite.
//
// A stand-in `codex` earlier on PATH appends the environment it was actually given. The spawn is
// real: this is the env the binary sees, not the options object the adapter built.

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 10_000 };
const HISTORY: TurnMessage[] = [{ kind: 'user', text: 'say hi' }];

/** One invocation of the stand-in: the MAF_* names it saw, and whether the rest of the env arrived. */
interface Observed {
  maf: string[];
  path: boolean;
  home: boolean;
  provider: boolean;
}

/**
 * A `codex` in a temp bin dir that appends its environment, then answers `ok`.
 *
 * Codex takes its prompt on stdin, so the stand-in drains it — except for `--version`, which is
 * asked through `execFile` with a stdin nobody closes, and where a `cat` would wait forever.
 */
async function standIn(t: TestContext): Promise<{ binDir: string; record: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-codex-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'observed.jsonl');
  await mkdir(binDir);

  const js = 'const fs=require("node:fs");' +
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({` +
    'maf: Object.keys(process.env).filter((k) => /^MAF_/.test(k)),' +
    'path: process.env.PATH !== undefined,' +
    'home: process.env.HOME !== undefined,' +
    'provider: process.env.ANTHROPIC_API_KEY !== undefined }) + "\\n");';
  await writeFile(path.join(binDir, 'codex'),
    '#!/bin/sh\n' +
    '[ "$1" = \'--version\' ] || cat >/dev/null 2>&1\n' +
    `${JSON.stringify(process.execPath)} -e '${js}' >/dev/null\n` +
    'printf \'ok\\n\'\n');
  await chmod(path.join(binDir, 'codex'), 0o755);
  return { binDir, record };
}

/** The stand-in first on PATH, and maf's own variables set, for the duration of one test. */
function withMafEnv(t: TestContext, binDir: string): void {
  const vars: Record<string, string> = {
    PATH:              `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    MAF_SIGNING_KEY:   'test-signing-key',
    MAF_RUNTIME_STATE: '/tmp/maf-state-must-not-reach-the-backend',
    ANTHROPIC_API_KEY: 'test-provider-key',
  };
  const saved = Object.entries(vars).map(([k]) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Every environment the stand-in was given, in spawn order; `[]` when it was never spawned. */
async function observed(record: string): Promise<Observed[]> {
  let text: string;
  try {
    text = await readFile(record, 'utf8');
  } catch {
    return [];
  }
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Observed);
}

/** What every spawn must show: no MAF_* variable, and an environment that is not simply empty. */
function assertBackendEnv(seen: Observed, what: string): void {
  assert.deepEqual(seen.maf, [], `${what}: no MAF_* variable reaches the backend`);
  assert.equal(seen.path, true, `${what}: the backend still gets PATH (the filter is not "no environment")`);
  assert.equal(seen.home, true, `${what}: and HOME, which the CLI needs for its own config`);
  assert.equal(seen.provider, true, `${what}: and the provider key, which the CLI needs to answer`);
}

test('a `codex` the adapter spawns gets the backend env, with no MAF_* variable in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binDir, record } = await standIn(t);
  withMafEnv(t, binDir);

  const out = await new CodexAdapter().invoke(CALL);
  assert.equal(out.exitCode, 0, out.output);

  const seen = await observed(record);
  assert.equal(seen.length, 1, 'the cli-tier `invoke` spawned the stand-in exactly once');
  assertBackendEnv(seen[0]!, 'invoke');
});

test('a governed turn (`sendTurn`) spawns `codex` with the backend env, no MAF_* in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binDir, record } = await standIn(t);
  withMafEnv(t, binDir);

  const turn = await new CodexAdapter().sendTurn(HISTORY, CALL);
  assert.equal(turn.text, 'ok', 'the stand-in answered, so the spawn is the one that was recorded');

  const seen = await observed(record);
  assert.equal(seen.length, 1, 'the governed turn spawned the stand-in exactly once');
  assertBackendEnv(seen[0]!, 'sendTurn');
});

test('the `--version` question `isAvailable` asks reaches a `codex` with the backend env, no MAF_* in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binDir, record } = await standIn(t);
  withMafEnv(t, binDir);

  assert.equal(await new CodexAdapter().isAvailable(), true);

  const seen = await observed(record);
  assert.equal(seen.length, 1, '`isAvailable` put its one question to the stand-in');
  assertBackendEnv(seen[0]!, 'isAvailable');
});
