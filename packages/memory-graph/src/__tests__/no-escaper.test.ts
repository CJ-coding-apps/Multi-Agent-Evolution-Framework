import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { intLiteral } from '../cypherText.js';

// ORACLE (DEFECT_SWEEP_2026-09-25.md D-08/D-20/D-19; IMPLEMENTATION_CHECKLIST A2-3).
//
// The defect was a *concept*, held in three identical copies and used at 17 call sites: a value
// was made safe by rewriting it on its way into a query. `.replace(/'/g, "''")` — SQL quote
// doubling, applied to Cypher, where it is not an escape at all. Fixing call sites would have
// left the next one free to reintroduce it, so the escaper was deleted and values are bound.
//
// That is a property of the *source*, not of any one function, so it is enforced by reading the
// source: a stray escaper or a `$name`-substituting helper anywhere under a package's `src` makes
// this test fail. The rules are cheap; adding a file here is a decision, not an accident.
//
// `__tests__` is excluded, and has to be: this file and `graph-parameters.test.ts` both name the
// idiom they forbid, in prose and in a regex, in order to forbid it.

/** From `packages/memory-graph/dist/__tests__/` up to the repo root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/**
 * A `replace()` whose needle is a single quote — the quote-doubling escaper. Cypher does not use
 * doubled quotes; `''` is an empty string there, so this never protected anything.
 */
const QUOTE_DOUBLING = /replace\(\s*\/'\/g/;

/**
 * A `replace()` whose needle is a `$name` placeholder, in either needle form
 * (`/\$tool/…` or `'$tool'…`). This is how a value gets substituted into a Cypher template, which
 * is the second half of the same defect: it looks like a bind and is not one. A needle form this
 * does not cover is a place to extend the rule, not a hole to write around.
 */
const TEMPLATE_SUBSTITUTION = /replace\(\s*(?:\/\\\$|['"]\$)[A-Za-z_]/;

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

/** Every first-party `.ts` file under each package's `src`, excluding tests. */
async function sourceFiles(): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const group of ['', 'adapters']) {
    const groupDir = path.join(PACKAGES_DIR, group);
    let packages: string[];
    try {
      packages = (await readdir(groupDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // no adapters group
    }
    for (const pkg of packages) {
      let files: string[];
      try {
        files = await walk(path.join(groupDir, pkg, 'src'));
      } catch {
        continue; // a package with no src/ has nothing to scan
      }
      for (const file of files) {
        out.push({
          rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
          text: await readFile(file, 'utf8'),
        });
      }
    }
  }
  return out;
}

/** Files containing `needle`, as repo-relative paths. */
function containing(files: Array<{ rel: string; text: string }>, needle: RegExp): string[] {
  return files.filter((f) => needle.test(f.text)).map((f) => f.rel).sort();
}

test('the scan finds the files it claims to check', async () => {
  // Without this, a broken walk would report "no violations" for an empty list and both rules
  // below would pass vacuously.
  const files = await sourceFiles();
  assert.ok(files.length > 100, `expected the whole monorepo, found ${files.length} files`);
  assert.ok(
    files.some((f) => f.rel === 'packages/memory-graph/src/MemoryGraph.ts'),
    'walk missed packages/memory-graph/src/MemoryGraph.ts',
  );
});

test('nothing rewrites a quote on its way into a query', async () => {
  assert.deepEqual(containing(await sourceFiles(), QUOTE_DOUBLING), [],
    'a value is bound, never escaped: declare it in `params` and let the driver bind it');
});

test('nothing substitutes a value into a query by placeholder name', async () => {
  assert.deepEqual(containing(await sourceFiles(), TEMPLATE_SUBSTITUTION), [],
    'a Cypher template names its parameters; it does not have them written in');
});

// The one place a value still becomes query text is `intLiteral`, for `LIMIT` and a
// variable-length path's hop count — positions Kùzu will not take a parameter for. It is in this
// file because it is the surviving half of the same invariant: the only value-to-text conversion
// left, and it must refuse anything that is not a small non-negative integer rather than coerce.

test('intLiteral passes a non-negative integer through and refuses everything else', async () => {
  assert.equal(intLiteral(0, 'limit'), '0');
  assert.equal(intLiteral(30, 'maxNodes'), '30');

  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => intLiteral(bad, 'limit'), /must be a non-negative integer/,
      `${String(bad)} must not become query text`);
  }
  // A string reaching this position is the defect the function exists for: `Number('1 DETACH
  // DELETE n')` is `NaN`, and a coercion would have written the tail into the statement.
  assert.throws(
    () => intLiteral(`1 DETACH DELETE n` as unknown as number, 'limit'),
    /must be a non-negative integer/,
  );
});
