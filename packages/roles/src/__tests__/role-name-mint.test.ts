import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// ORACLE (DEFECT_SWEEP_2026-09-25.md D-07): a `RoleName` means "a role set defines this
// name". That is the whole guarantee — it is why an unknown role cannot reach the
// dispatcher, and it holds only while the mint stays where it is. A stray `as RoleName` in
// some later package would re-open the hole silently, with no compile error anywhere.
//
// These two rules are cheap and they are the enforcement point. A new legitimate mint site
// is a decision, not an accident: adding a file here is the review.

/** From `packages/roles/dist/__tests__/` up to the repo root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/** The one cast that defines the mint. Nothing else may cast to `RoleName`. */
const MINT_DEFINITION = 'packages/roles/src/RoleConfig.ts';

/**
 * Files that may *call* the mint, because each one authors a role set — the act of defining
 * which names exist. `roles.yaml` (`RoleRegistry.parseRoleSet`), the built-in set, and a
 * harness's carried role set are the same kind of thing; `index.ts` re-exports the function.
 */
const ROLE_SET_AUTHORS = new Set([
  MINT_DEFINITION,
  'packages/roles/src/RoleRegistry.ts',
  'packages/roles/src/defaults.ts',
  'packages/roles/src/harnessBridge.ts',
  'packages/roles/src/index.ts',
]);

/** Every first-party `.ts` file under each package's `src`, excluding tests and build output. */
async function sourceFiles(): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  const packages = (await readdir(PACKAGES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const pkg of packages) {
    const srcDir = path.join(PACKAGES_DIR, pkg, 'src');
    let entries: string[];
    try {
      entries = await walk(srcDir);
    } catch {
      continue; // a package with no src/ has nothing to scan
    }
    for (const file of entries) {
      out.push({
        rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
        text: await readFile(file, 'utf8'),
      });
    }
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...await walk(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Files containing `needle`, as repo-relative paths. */
function containing(files: Array<{ rel: string; text: string }>, needle: RegExp): string[] {
  return files.filter((f) => needle.test(f.text)).map((f) => f.rel).sort();
}

test('the scan finds the files it claims to check', async () => {
  // Without this, a broken walk would report "no violations" for an empty list and the
  // two rules below would pass vacuously.
  const files = await sourceFiles();
  assert.ok(files.length > 100, `expected the whole monorepo, found ${files.length} files`);
  assert.ok(files.some((f) => f.rel === MINT_DEFINITION), `walk missed ${MINT_DEFINITION}`);
});

test('`as RoleName` appears only where the mint is defined', async () => {
  const offenders = containing(await sourceFiles(), /\bas\s+RoleName\b/);
  assert.deepEqual(offenders, [MINT_DEFINITION],
    'a `RoleName` may only be produced by the mint in @maf/roles; anything else must resolve one');
});

test('the mint is called only by files that define a role set', async () => {
  const offenders = containing(await sourceFiles(), /defineRoleName/)
    .filter((rel) => !ROLE_SET_AUTHORS.has(rel));
  assert.deepEqual(offenders, [],
    'defineRoleName is for authoring a role set; a caller that wants a name for a role set it did not define must resolve it');
});
