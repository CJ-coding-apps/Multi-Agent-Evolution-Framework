import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// ORACLE (S6 MED-3). WP-3.14 is about to add `requiresTool` to a role. The generator must carry every
// key the source declares, or that field would be silently absent from the built-in set — and the
// drift test compares whole objects, so it would then fail, which is the point: an edit to the source
// that is not regenerated must turn `--check` red. This test runs the real generator in a copy of the
// tree, so it can add the field without touching this repository.

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts', 'generate-default-roles.mjs');
const execFileAsync = promisify(execFile);

async function generate(root: string, check: boolean): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [path.join(root, 'scripts', 'generate-default-roles.mjs'), ...(check ? ['--check'] : [])],
      { cwd: root },
    );
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('a role field added to the source alone is carried, and turns --check red until regenerated (MED-3)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-generator-fieldset-'));
  try {
    // The smallest tree the generator writes into: the script, the shipped files, and its outputs.
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'roles', 'src'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'cli', 'assets', 'harnesses'), { recursive: true });
    await cp(SCRIPT, path.join(root, 'scripts', 'generate-default-roles.mjs'));
    await cp(path.join(REPO, '.maf'), path.join(root, '.maf'), { recursive: true });

    assert.equal((await generate(root, false)).code, 0, 'the copy generates cleanly');
    assert.equal((await generate(root, true)).code, 0, 'and is immediately up to date');

    // The source-only edit: a field the generator has never heard of.
    const rolesPath = path.join(root, '.maf', 'roles.yaml');
    const parsed = JSON.parse(await readFile(rolesPath, 'utf8')) as {
      roles: Array<{ role: string; requiresTool?: string }>;
    };
    const tester = parsed.roles.find((role) => role.role === 'tester');
    assert.ok(tester, 'the shipped set has a tester');
    tester.requiresTool = 'test.run';
    await writeFile(rolesPath, JSON.stringify(parsed, null, 2), 'utf8');

    const stale = await generate(root, true);
    assert.equal(stale.code, 1, `--check fails on an unregenerated field: ${stale.output}`);
    assert.match(stale.output, /defaultRoleSet\.generated\.ts/);
    assert.match(stale.output, /default-[0-9a-f]{64}\.json/, 'the committed harness is out of date too');

    assert.equal((await generate(root, false)).code, 0, 'regenerating accepts the field without an edit');
    const module = await readFile(path.join(root, 'packages', 'roles', 'src', 'defaultRoleSet.generated.ts'), 'utf8');
    assert.match(module, /requiresTool: "test\.run",/,
      'the generated built-in set carries the field the file declares');
    assert.equal((await generate(root, true)).code, 0, 'and the tree is up to date again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
