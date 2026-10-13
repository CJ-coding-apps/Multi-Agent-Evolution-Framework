import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarnessRoleSet } from '../index.js';
import { HarnessStore, resolveHarnessRef } from '../index.js';

// ORACLE: plain runs started together share one store. None of them may see a half-written file
// and report the store as tampered — the failure the verifier reproduced with concurrent runs
// (F3). Separate processes, because that is what concurrent `maf run`s are.

const run = promisify(execFile);
const INDEX_JS = path.join(__dirname, '..', 'index.js');

/** About 12 KB of role set: big enough that writing the file is not one indivisible step. */
const ROLE_SET: HarnessRoleSet = {
  version: 1,
  defaultRole: 'r0',
  roles: Array.from({ length: 6 }, (_, i) => ({
    role: `r${i}`,
    systemPrompt: `You are role ${i}. `.repeat(130),
    allowedTools: ['fs.read'],
  })),
};

// Each child loops either resolving the harness as a plain run does, or saving the same harness
// as concurrent first mints do, and prints what it saw.
const CHILD = `
const { HarnessStore, resolveHarnessRef, mintHarnessConfig, LEGACY_DEFAULT_ID } = require(process.argv[1]);
const [dir, mode, roleSetJson, iterations] = process.argv.slice(2);
const roleSet = JSON.parse(roleSetJson);
(async () => {
  const out = { shas: [], errors: [] };
  for (let i = 0; i < Number(iterations); i++) {
    const store = new HarnessStore(dir);
    try {
      if (mode === 'save') {
        await store.save(mintHarnessConfig({ id: LEGACY_DEFAULT_ID, roleSet, processorBundles: [] }));
      } else {
        out.shas.push((await resolveHarnessRef({ legacyRoleSet: async () => roleSet }, store)).harness.sha);
      }
    } catch (err) {
      out.errors.push(err.name + ': ' + err.message);
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
`;

test('plain runs resolving the same harness at once never see a half-written file', async () => {
  assert.ok(JSON.stringify(ROLE_SET).length >= 12_000);
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-harness-concurrency-'));
  try {
    const { harness } = await resolveHarnessRef({ legacyRoleSet: async () => ROLE_SET }, new HarnessStore(dir));
    const modes = ['resolve', 'resolve', 'resolve', 'resolve', 'save', 'save'];
    const results = await Promise.all(modes.map(async (mode) => {
      const { stdout } = await run(process.execPath, ['-e', CHILD, INDEX_JS, dir, mode, JSON.stringify(ROLE_SET), '25']);
      return JSON.parse(stdout) as { shas: string[]; errors: string[] };
    }));
    assert.deepEqual(results.flatMap((r) => r.errors), []);
    const shas = results.flatMap((r) => r.shas);
    assert.equal(shas.length, 4 * 25);
    assert.ok(shas.every((sha) => sha === harness.sha));
    // Every write went through a temp file that was renamed into place; none is left behind.
    assert.deepEqual((await readdir(path.join(dir, 'harnesses'))).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
