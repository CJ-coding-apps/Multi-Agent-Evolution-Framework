import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { computeHarnessSha, mintHarnessConfig } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { RoleRegistry, harnessRoleSetFromRegistry } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';

// ORACLE (S6 MED-2). The committed `default-<sha>.json` is a third copy of the role set — beside the
// shipped files and the generated module — and nothing kept it in sync. A prompt edit regenerated the
// module but left the committed default carrying the old prompt, so a fresh clone's first `goldens`
// run would dispatch stale text. This test mints the harness the way a run does, with the real code,
// and compares the result to both committed copies (the repository's `.maf/` and the package asset)
// byte for byte. `scripts/generate-default-roles.mjs` writes both, and its `--check` mode runs in
// `one-role-set.test.ts`; this is the independent reading of the same fact.

const REPO = path.resolve(__dirname, '../../../..');
const MAF = path.join(REPO, '.maf');
const DIRS = [path.join(MAF, 'harnesses'), path.join(REPO, 'packages', 'cli', 'assets', 'harnesses')];
const DEFAULT_RE = /^default-([0-9a-f]{64})\.json$/;

test('the committed default harness is the one this source mints, in both copies (MED-2)', async () => {
  const registry = await RoleRegistry.fromYamlOrDefault(
    path.join(MAF, 'roles.yaml'), MAF, createDefaultRegistry(),
  );
  const minted = mintHarnessConfig({
    id: 'default',
    roleSet: await harnessRoleSetFromRegistry(registry),
    processorBundles: [],
  });

  for (const dir of DIRS) {
    const names = (await readdir(dir)).filter((name) => DEFAULT_RE.test(name));
    assert.equal(names.length, 1, `${dir} carries exactly one default harness — found ${names.join(', ') || 'none'}`);
    const name = names[0] as string;
    const bytes = await readFile(path.join(dir, name), 'utf8');
    const parsed = JSON.parse(bytes) as HarnessConfig;
    assert.equal(name, `default-${minted.sha}.json`, `${name} is named for the sha the source mints now`);
    assert.equal(parsed.sha, minted.sha);
    assert.equal(computeHarnessSha(parsed), minted.sha, 'and its own content hashes to that sha');
    assert.equal(bytes, JSON.stringify(minted, null, 2),
      `${path.join(dir, name)} is byte for byte the harness the source mints — regenerate it with ` +
      'node scripts/generate-default-roles.mjs');
  }
});
