import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, ToolDeclarationError } from '@maf/types';
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

test('strip deeper than the path leaves patch nothing to open, so the call is refused', () => {
  assert.throws(() => extractDiffPaths('--- a/foo\n+++ b/foo\n', 2), ToolDeclarationError);
});

// ─── WP-3.9 F1: every header spelling `patch` reads ───────────────────────
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
  // Without the cut this declared "Cargo.lock\t2026-…", which matches no `**/Cargo.lock` rule.
  assert.deepEqual(extractDiffPaths(diff), ['Cargo.lock']);
});

test('a timestamp-less TAB suffix is cut the same way (a role\'s own diff spelling)', () => {
  const diff = '--- a/src/app.js\tlatest\n+++ b/src/app.js\tlatest\n@@ -1 +1 @@\n-x\n+y\n';
  // "src/app.js\tlatest" matched a tester rule's `**/*test*` glob and let the write through.
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
  // protect-secrets — was skipped, and patch wrote the file.
  const diff = 'Index: Cargo.lock\n@@ -1 +1 @@\n-a\n+b\n';
  // The reported call used `-p0`, which is what leaves a bare name intact.
  assert.deepEqual(extractDiffPaths(diff, 0), ['Cargo.lock']);
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

test('a diff --git header names both of a rename\'s paths', () => {
  const diff = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
  assert.deepEqual(extractDiffPaths(diff).sort(), ['new.ts', 'old.ts']);
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
  const record = path.join(root, 'record.json');
  await mkdir(binDir);
  const fake = path.join(binDir, 'patch');
  await writeFile(
    fake,
    `#!/bin/sh\n${process.execPath} -e 'const fs=require("node:fs");` +
    `const i=process.argv.indexOf("-i");const p=process.argv[i+1];` +
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({` +
    `args: process.argv.slice(2), file: p, mode: (fs.statSync(p).mode&0o777).toString(8),` +
    `maf: Object.keys(process.env).filter((k) => /^MAF_/i.test(k))}));' -- "$@"\n`,
  );
  await chmod(fake, 0o755);
  const savedPath = process.env['PATH'];
  const savedKey = process.env['MAF_SIGNING_KEY'];
  process.env['PATH'] = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  t.after(() => {
    process.env['PATH'] = savedPath;
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
  });

  const result = await new PatchApplyTool().execute({ diff: GIT_DIFF }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);

  const { args, file: tmpFile, mode, maf } = JSON.parse(await readFile(record, 'utf8')) as {
    args: string[]; file: string; mode: string; maf: string[];
  };
  assert.equal(mode, '600');
  // WP-3.9 F6: `patch` is a process maf spawns while an agent's diff is in flight; it gets the tool
  // allowlist, so a signing key in maf's own environment is not inherited by the child.
  assert.deepEqual(maf, [], 'no MAF_* variable reaches the patch process');
  // The two flags that keep a rejected hunk from leaving `<path>.orig` and `<path>.rej` behind:
  // both are a copy of the target and a copy of the hunk, and either can be a secret.
  assert.ok(args.includes('--no-backup-if-mismatch'), `argv was ${args.join(' ')}`);
  assert.ok(args.includes('--reject-file=-'), `argv was ${args.join(' ')}`);
  // The diff can hold a credential the agent is moving between files; it must not outlive the call.
  await assert.rejects(stat(tmpFile), { code: 'ENOENT' });
});

/** `patch` is required for the two tests that exercise the real binary. */
function patchAvailable(): boolean {
  try {
    execFileSync('patch', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('a hunk that does not apply leaves no .orig and no .rej beside the file', async (t) => {
  // SPEC-3B backlog P1. Before this, `patch` wrote `<path>.orig` — a copy of the target, which can
  // be an editor's `.env` — and `<path>.rej`, the rejected hunk text, which can hold a secret.
  if (process.platform === 'win32' || !patchAvailable()) {
    t.skip('needs a POSIX `patch` binary');
    return;
  }
  const root = await project(t);
  await writeFile(path.join(root, 'notes.txt'), 'alpha\n');

  const diff = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-not what is on disk\n+replacement\n';
  const result = await new PatchApplyTool().execute({ diff }, ctxIn(root));

  assert.notEqual(result.exitCode, 0, 'the hunk does not apply, so patch fails');
  assert.deepEqual((await readdir(root)).sort(), ['notes.txt'], 'nothing else was left behind');
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\n', 'the target is untouched');
  assert.match(result.stdout, /not what is on disk/, 'the reject was sent to the result, not to a .rej file');
});
