import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterInvokeOptions } from '@maf/types';
import { GeminiAdapter } from '../index.js';

// ORACLE (WP-3.9 F6, widened by round 3 H4): every `gemini` maf spawns is given `backendEnv()` —
// everything except `MAF_*` — at both places this adapter spawns it: the cli-tier `invoke` and the
// `--version` question `isAvailable` asks. Until the second test nothing proved the probe, and
// reverting it to `{ ...process.env }` passed the whole suite (the claude and codex adapters each
// already had this test; gemini did not).
//
// A stand-in `gemini` earlier on PATH records the environment it was actually given. The spawn is
// real: this is the env the binary sees, not the options object the adapter built.

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 10_000 };

interface Observed { maf: string[]; path: boolean; home: boolean }

/** A `gemini` in a temp bin dir that appends its environment, then answers `ok`. */
async function standIn(t: TestContext): Promise<{ binDir: string; record: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-gemini-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'observed.jsonl');
  await mkdir(binDir);

  const js = 'const fs=require("node:fs");' +
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({` +
    'maf: Object.keys(process.env).filter((k) => /^MAF_/i.test(k)),' +
    'path: process.env.PATH !== undefined, home: process.env.HOME !== undefined }) + "\\n");';
  await writeFile(path.join(binDir, 'gemini'),
    `#!/bin/sh\n${JSON.stringify(process.execPath)} -e '${js}' >/dev/null\nprintf 'ok\\n'\n`);
  await chmod(path.join(binDir, 'gemini'), 0o755);
  return { binDir, record };
}

/** The stand-in first on PATH, and maf's own variable set, for the duration of one test. */
function withMafEnv(t: TestContext, binDir: string): void {
  const savedPath = process.env['PATH'];
  const savedKey = process.env['MAF_SIGNING_KEY'];
  process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  t.after(() => {
    process.env['PATH'] = savedPath;
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
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

function assertBackendEnv(seen: Observed, what: string): void {
  assert.deepEqual(seen.maf, [], `${what}: no MAF_* variable reaches the backend`);
  assert.equal(seen.path, true, `${what}: the backend still gets PATH (the filter is not "no environment")`);
  assert.equal(seen.home, true, `${what}: and HOME, which the CLI needs for its own config`);
}

test('a `gemini` the adapter spawns gets the backend env, with no MAF_* variable in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binDir, record } = await standIn(t);
  withMafEnv(t, binDir);

  const out = await new GeminiAdapter().invoke(CALL);
  assert.equal(out.exitCode, 0, out.output);

  const seen = await observed(record);
  assert.equal(seen.length, 1, 'the cli-tier `invoke` spawned the stand-in exactly once');
  assertBackendEnv(seen[0]!, 'invoke');
});

test('the `--version` question `isAvailable` asks reaches a `gemini` with the backend env, no MAF_* in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binDir, record } = await standIn(t);
  withMafEnv(t, binDir);

  assert.equal(await new GeminiAdapter().isAvailable(), true);

  const seen = await observed(record);
  assert.equal(seen.length, 1, '`isAvailable` put its one question to the stand-in');
  assertBackendEnv(seen[0]!, 'isAvailable');
});
