import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolDeclarationError } from '@maf/types';
import { PatchApplyTool, extractDiffPaths } from '../plugins/patch.js';

test('extractDiffPaths pulls a/b prefixes off git-style diffs', () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;
  const paths = extractDiffPaths(diff);
  assert.deepEqual(paths.sort(), ['src/foo.ts']);
});

test('extractDiffPaths handles multi-file diffs', () => {
  const diff = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
--- a/sub/b.ts
+++ b/sub/b.ts
@@ -1 +1 @@
-1
+2
`;
  const paths = extractDiffPaths(diff);
  assert.deepEqual(paths.sort(), ['a.ts', 'sub/b.ts'].sort());
});

test('extractDiffPaths ignores /dev/null for added/deleted files', () => {
  const diff = `--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+contents
`;
  const paths = extractDiffPaths(diff);
  assert.deepEqual(paths, ['new.ts']);
});

test('extractDiffPaths refuses a diff whose headers name no file', () => {
  // Fail closed: a diff no path rule can see is a diff nothing can refuse, and the reported case
  // (`Index:`-only) was allowed and wrote the file it never declared.
  assert.throws(() => extractDiffPaths('just some random text'), ToolDeclarationError);
  assert.throws(() => extractDiffPaths('--- /dev/null\n+++ /dev/null\n'), ToolDeclarationError);
});

test('extractDiffPaths deduplicates --- and +++ for the same file', () => {
  const diff = `--- a/same.ts
+++ b/same.ts
@@ -1 +1 @@
-x
+y
`;
  assert.deepEqual(extractDiffPaths(diff), ['same.ts']);
});

// ─── every header spelling `patch` reads ───────────────────────────────────
//
// Each of these was a bypass in released code: the name was kept whole (so no path rule matched
// the file the command went on to write) or was never read at all (so no rule saw any path).

const STAMP = '\t2026-01-01 00:00:00.000000000 +0000';

test('a unified header is cut at the TAB before the timestamp', () => {
  const diff = [
    `--- a/Cargo.lock${STAMP}`,
    `+++ b/Cargo.lock${STAMP}`,
    '@@ -1 +1 @@', '-a', '+b', '',
  ].join('\n');
  // Without the cut this declared "Cargo.lock\t2026-…", which matches no `**/*.lock` rule.
  assert.deepEqual(extractDiffPaths(diff), ['Cargo.lock']);
});

test('a timestamp-less TAB suffix is cut the same way', () => {
  const diff = '--- a/src/app.js\tlatest\n+++ b/src/app.js\tlatest\n@@ -1 +1 @@\n-x\n+y\n';
  assert.deepEqual(extractDiffPaths(diff), ['src/app.js']);
});

test('a TAB inside a quoted file name is not a timestamp', () => {
  const diff = `diff --git "a/we\tird.txt" "b/we\tird.txt"
--- "a/we\tird.txt"
+++ "b/we\tird.txt"
@@ -1 +1 @@
-x
+y
`;
  assert.deepEqual(extractDiffPaths(diff), ['we\tird.txt']);
});

test('an Index:-only diff declares the file it names', () => {
  // The reported bypass: this declared nothing, so every path rule — protect-lock-files,
  // deny-env-files — was skipped, and patch wrote the file.
  assert.deepEqual(extractDiffPaths('Index: Cargo.lock\n@@ -1 +1 @@\n-a\n+b\n', 0), ['Cargo.lock']);
  assert.deepEqual(extractDiffPaths('Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n', 0), ['.env']);
});

test('a context diff names both files on its *** / --- pair, and skips its hunk separators', () => {
  const diff = [
    '*** old/src/foo.txt' + STAMP,
    '--- new/src/foo.txt' + STAMP,
    '***************',
    '*** 1,2 ****',
    '  same',
    '- old',
    '--- 1,2 ----',
    '  same',
    '+ new',
    '',
  ].join('\n');
  // `***************` and `1,2 ----` are structural lines, not names; only the pair is.
  assert.deepEqual(extractDiffPaths(diff), ['src/foo.txt']);
});

test('a diff --git header with a TAB names both of a rename\'s paths, cut at the TAB', () => {
  const diff = `diff --git a/old.ts b/new.ts${STAMP}\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n`;
  assert.deepEqual(extractDiffPaths(diff).sort(), ['new.ts', 'old.ts']);
});

test('strip is the same number the command is given', () => {
  const GIT_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;
  // `patch -p0` on a git diff touches `a/src/foo.ts`; declaring `src/foo.ts` would hand the
  // policy a file the command never writes, and leave the one it does write unseen.
  assert.deepEqual(extractDiffPaths(GIT_DIFF, 0), ['a/src/foo.ts', 'b/src/foo.ts']);
  assert.deepEqual(extractDiffPaths(GIT_DIFF, 1), ['src/foo.ts']);
  // Strip deeper than the path leaves patch nothing to open, so the call is refused.
  assert.throws(() => extractDiffPaths('--- a/foo\n+++ b/foo\n', 2), ToolDeclarationError);
  // A strip the command would reject is not one the declaration honours either: both read one value.
  assert.deepEqual(extractDiffPaths(GIT_DIFF, -1), extractDiffPaths(GIT_DIFF, 1));
});

test('declaredPaths honours strip and refuses a call with no diff', () => {
  const tool = new PatchApplyTool();
  assert.deepEqual(tool.declaredPaths({ diff: '--- a/foo.ts\n+++ b/foo.ts\n' }), ['foo.ts']);
  assert.deepEqual(tool.declaredPaths({ diff: '--- a/foo.ts\n+++ b/foo.ts\n', strip: 0 }), ['a/foo.ts', 'b/foo.ts']);
  assert.throws(() => tool.declaredPaths({} as unknown as { diff: string }), ToolDeclarationError);
});
