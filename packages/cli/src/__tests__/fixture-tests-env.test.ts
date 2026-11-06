import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFixtureTests } from '../commands/inprocessDemo.js';

// ORACLE (WP-3.9 F2): `inprocess-demo` observes the coder's work by running the fixture's own
// `npm test`. In `--live` the model wrote that package.json, so it is agent-touched code and must
// not inherit maf's environment — it used to get `{ ...process.env }`, `MAF_SIGNING_KEY` included.
//
// The script writes the environment it was actually handed to a file; the assertion is on that.

const PROBE = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.writeFileSync(path.join(__dirname, 'observed.json'), JSON.stringify({",
  "  maf: Object.keys(process.env).filter((k) => /^MAF_/i.test(k)),",
  "  path: process.env.PATH !== undefined,",
  "}));",
  "console.log('PASS');",
  '',
].join('\n');

test('the demo runs the fixture\'s npm test with the tool allowlist, not maf\'s environment', async (t) => {
  if (process.platform === 'win32') return; // `npm` is a shell script/.cmd there; execFileSync would not find it

  const fixture = await mkdtemp(path.join(tmpdir(), 'maf-fixture-tests-env-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node probe.js' } }, null, 2), 'utf8');
  await writeFile(path.join(fixture, 'probe.js'), PROBE, 'utf8');

  const savedKey = process.env['MAF_SIGNING_KEY'];
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  t.after(() => {
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
  });

  const { passed, output } = runFixtureTests(fixture);
  assert.equal(passed, true, output);

  const observed = JSON.parse(await readFile(path.join(fixture, 'observed.json'), 'utf8')) as {
    maf: string[]; path: boolean;
  };
  assert.deepEqual(observed.maf, [], 'no MAF_* variable reaches the fixture\'s test script');
  assert.equal(observed.path, true, 'the script still gets PATH (the filter is not "no environment")');
});
