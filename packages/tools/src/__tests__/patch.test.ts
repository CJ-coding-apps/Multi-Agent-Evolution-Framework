import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDiffPaths } from '../plugins/patch.js';

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

test('extractDiffPaths returns empty on diff without file headers', () => {
  assert.deepEqual(extractDiffPaths('just some random text'), []);
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
