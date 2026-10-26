import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVerifier } from '../verifiers.js';

// ORACLE (WP-3.9 F2): a `test-script` verifier runs a command the task owns inside the work dir the
// coder just edited — agent-touched code. It used to inherit maf's whole environment, so a fixture's
// `npm test` saw `MAF_SIGNING_KEY` and every provider token. Reverting the spawn to the ambient
// environment passed the suite: nothing asserted what the child was given.
//
// The child here is node itself, so this runs on every platform; it records the environment it was
// actually handed and the assertion is on that, not on the options object the verifier built.

test('a test-script verifier runs the task\'s command with the tool allowlist, not maf\'s environment', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'maf-verifier-env-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const record = path.join(workDir, 'observed.json');

  const js = 'const fs=require("node:fs");' +
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({` +
    'maf: Object.keys(process.env).filter((k) => /^MAF_/i.test(k)),' +
    'path: process.env.PATH !== undefined }));';

  const savedKey = process.env['MAF_SIGNING_KEY'];
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  t.after(() => {
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
  });

  const outcome = await runVerifier(
    { kind: 'test-script', command: process.execPath, args: ['-e', js], expectExit: 0 },
    { workDir, output: '', diff: '', corpusRoot: workDir },
  );
  assert.equal(outcome.passed, true, outcome.detail);

  const observed = JSON.parse(await readFile(record, 'utf8')) as { maf: string[]; path: boolean };
  assert.deepEqual(observed.maf, [], 'no MAF_* variable reaches the task\'s command');
  assert.equal(observed.path, true, 'the command still gets PATH (the filter is not "no environment")');
});
