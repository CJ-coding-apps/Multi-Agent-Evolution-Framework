import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId } from '@maf/types';
import { PatchApplyTool, extractDiffPaths, patchWritePaths } from '../plugins/patch.js';

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-patch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

const ctxIn = (root: string): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy: ALLOW, attestor: NO_ATTESTOR,
});

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

// ─── WP-3.9: the declaration names the files `patch` actually touches ──────

const GIT_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;

test('strip 0 declares the a/-prefixed path that patch -p0 will open', () => {
  // `patch -p0` on a git diff touches `a/src/foo.ts`; declaring `src/foo.ts` would hand the
  // policy a file the command never writes, and leave the one it does write unseen.
  assert.deepEqual(extractDiffPaths(GIT_DIFF, 0), ['a/src/foo.ts', 'b/src/foo.ts']);
  assert.deepEqual(extractDiffPaths(GIT_DIFF, 1), ['src/foo.ts']);
});

test('strip deeper than the path leaves patch nothing to open, so nothing is declared', () => {
  assert.deepEqual(extractDiffPaths('--- a/foo\n+++ b/foo\n', 2), []);
});

test('patchWritePaths declares the reject and backup siblings beside each target', () => {
  assert.deepEqual(patchWritePaths(['.env']).sort(), ['.env', '.env.orig', '.env.rej']);
});

test('declaredPaths names the targets, their .orig/.rej siblings, and honours strip', () => {
  const tool = new PatchApplyTool();
  assert.deepEqual(tool.declaredPaths({ diff: GIT_DIFF }).sort(), [
    'src/foo.ts', 'src/foo.ts.orig', 'src/foo.ts.rej',
  ]);
  assert.deepEqual(tool.declaredPaths({ diff: GIT_DIFF, strip: 0 }).sort(), [
    'a/src/foo.ts', 'a/src/foo.ts.orig', 'a/src/foo.ts.rej',
    'b/src/foo.ts', 'b/src/foo.ts.orig', 'b/src/foo.ts.rej',
  ]);
});

test('a diff that would land in .git is refused before any policy rule', () => {
  const tool = new PatchApplyTool();
  assert.throws(() => tool.declaredPaths({ diff: '--- a/.git/config\n+++ b/.git/config\n' }), /\.git/);
});

// ─── WP-3.9: the temp diff is private and removed ─────────────────────────
//
// Executed rather than inspected: a fake `patch` on PATH records the mode of the file it was
// handed. The real binary would apply the diff, and what this test is about is the file `patch`
// reads, not what it writes.

test('execute writes the temp diff 0600, hands it to patch, and removes it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture; the mode bits are POSIX
  const root = await project(t);
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'record.txt');
  await mkdir(binDir);
  const fake = path.join(binDir, 'patch');
  await writeFile(
    fake,
    `#!/bin/sh\n${process.execPath} -e 'const fs=require("node:fs");` +
    `const i=process.argv.indexOf("-i");const p=process.argv[i+1];` +
    `fs.writeFileSync(${JSON.stringify(record)}, p+" "+(fs.statSync(p).mode&0o777).toString(8));' -- "$@"\n`,
  );
  await chmod(fake, 0o755);
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  t.after(() => { process.env['PATH'] = savedPath; });

  const result = await new PatchApplyTool().execute({ diff: GIT_DIFF }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);

  const [tmpFile, mode] = (await readFile(record, 'utf8')).split(' ');
  assert.equal(mode, '600');
  // The diff can hold a credential the agent is moving between files; it must not outlive the call.
  await assert.rejects(stat(tmpFile!), { code: 'ENOENT' });
});
