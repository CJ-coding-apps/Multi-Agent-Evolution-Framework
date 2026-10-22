import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterInvokeOptions } from '@maf/types';
import { GeminiAdapter } from '../index.js';

// ORACLE (WP-3.9 F6): every `gemini` maf spawns is given `backendEnv()` — everything except
// `MAF_*` — and until this test nothing proved it at the adapter. Reverting the spawn to
// `{ ...process.env }` passed the whole suite.
//
// A stand-in `gemini` earlier on PATH records the environment it was actually given. The spawn is
// real: this is the env the binary sees, not the options object the adapter built.

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 10_000 };

test('a `gemini` the adapter spawns gets the backend env, with no MAF_* variable in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture

  const root = await mkdtemp(path.join(tmpdir(), 'maf-gemini-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'observed.json');
  await mkdir(binDir);

  const js = 'const fs=require("node:fs");' +
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({` +
    'maf: Object.keys(process.env).filter((k) => /^MAF_/i.test(k)),' +
    'path: process.env.PATH !== undefined, home: process.env.HOME !== undefined }));';
  await writeFile(path.join(binDir, 'gemini'), `#!/bin/sh\n${JSON.stringify(process.execPath)} -e '${js}' >/dev/null\nprintf 'ok\\n'\n`);
  await chmod(path.join(binDir, 'gemini'), 0o755);

  const savedPath = process.env['PATH'];
  const savedKey = process.env['MAF_SIGNING_KEY'];
  process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  t.after(() => {
    process.env['PATH'] = savedPath;
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
  });

  const out = await new GeminiAdapter().invoke(CALL);
  assert.equal(out.exitCode, 0, out.output);

  const observed = JSON.parse(await readFile(record, 'utf8')) as {
    maf: string[]; path: boolean; home: boolean;
  };
  assert.deepEqual(observed.maf, [], 'no MAF_* variable reaches the backend');
  assert.equal(observed.path, true, 'the backend still gets PATH (the filter is not "no environment")');
  assert.equal(observed.home, true, 'and HOME, which the CLI needs for its own config');
});
