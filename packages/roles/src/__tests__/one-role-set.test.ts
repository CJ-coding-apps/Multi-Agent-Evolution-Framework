import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDefaultRegistry } from '@maf/tools';
import { DEFAULT_ROLE_SET } from '../defaults.js';
import { RoleRegistry } from '../RoleRegistry.js';
import type { RoleConfig } from '../RoleConfig.js';

// ORACLE: D-61 — there is one default role set, not two. The files in `.maf/` (which `maf init`
// writes from `packages/cli/assets/` and which a run in this repository loads) are the source; the
// built-in `DEFAULT_ROLE_SET` is generated from them. Before 3.15 the two were maintained by hand
// and drifted: the prompts differed, and the built-in `tester` held no `fs.write` while the shipped
// one did (F2). These tests are the drift check — they fail the moment either side moves alone.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MAF_DIR = path.join(REPO_ROOT, '.maf');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-default-roles.mjs');
const execFileAsync = promisify(execFile);

/** Everything a role may declare. `promptFile` is excluded: the built-in carries the text. */
const FIELDS = [
  'description', 'policyTag', 'model', 'execution', 'expectsChange', 'expectsToolCalls',
  'timeoutMs', 'maxToolIterations', 'tokenBudget',
] as const;

async function shippedRoles(): Promise<RoleRegistry> {
  return RoleRegistry.fromYamlOrDefault(
    path.join(MAF_DIR, 'roles.yaml'), MAF_DIR, createDefaultRegistry(),
  );
}

test('the built-in set is the shipped roles.yaml, role for role and field for field (D-61)', async () => {
  const shipped = await shippedRoles();
  assert.equal(DEFAULT_ROLE_SET.defaultRole, shipped.defaultRole);
  assert.deepEqual(
    DEFAULT_ROLE_SET.roles.map((r) => String(r.role)),
    shipped.list().map((r) => String(r.role)),
    'the roles and their order come from the file, and the order is how they were declared',
  );
  for (const built of DEFAULT_ROLE_SET.roles) {
    const fromFile = shipped.getRole(built.role);
    for (const field of FIELDS) {
      assert.deepEqual(
        built[field], fromFile[field],
        `role "${built.role}" declares ${field} as ${JSON.stringify(fromFile[field])} in ` +
        `.maf/roles.yaml but the built-in set has ${JSON.stringify(built[field])}`,
      );
    }
    assert.deepEqual(
      built.allowedTools.map(String).sort(),
      fromFile.allowedTools.map(String).sort(),
      `role "${built.role}" allows a different set of tools in the two sets`,
    );
  }
});

test('the built-in prompts are the shipped prompt files, byte for byte (D-61)', async () => {
  const shipped = await shippedRoles();
  for (const built of DEFAULT_ROLE_SET.roles) {
    const fromFile = shipped.getRole(built.role);
    assert.ok(fromFile.promptFile, `role "${built.role}" must name its prompt file in .maf/roles.yaml`);
    assert.equal(
      built.systemPrompt, await shipped.loadPrompt(fromFile),
      `role "${built.role}"'s built-in prompt is not the text of ${fromFile.promptFile}`,
    );
  }
});

test('the generated module is current with the shipped files (D-61)', async () => {
  // `--check` exits 1 when `defaultRoleSet.generated.ts` is out of date. Running it here is what
  // turns "regenerate after editing .maf/" from a convention into a failing test.
  await execFileAsync(process.execPath, [GENERATOR, '--check'], { cwd: REPO_ROOT });
});

test('no built-in role declares a promptFile — the built-in set has no files to read (D-08)', () => {
  // A target with no `.maf/prompts/` runs this set. A promptFile here would be a path it cannot
  // follow, which is why the generator emits the text and drops the path.
  for (const role of DEFAULT_ROLE_SET.roles as RoleConfig[]) {
    assert.equal(role.promptFile, undefined, `role "${role.role}" carries a promptFile`);
  }
});
