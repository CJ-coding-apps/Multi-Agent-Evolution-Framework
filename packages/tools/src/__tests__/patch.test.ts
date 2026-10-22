import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AttestorHandle, PolicyDecision, PolicyEngineHandle, ToolContext, ToolResult,
} from '@maf/types';
import {
  makeAgentId, makeRunId, makeTaskId, PathConfinementError, ToolDeclarationError,
} from '@maf/types';
import { PatchApplyTool } from '../plugins/patch.js';

// ORACLE: 0.5.1 — one parser. `git apply` is both the declaration and the applier, so the set of
// files the policy is asked about is the set git writes, or the call is refused before the policy
// is asked. The previous design read the diff's headers itself, and `VERDICT-Verify2b` found five
// header forms that got past it (space timestamp, octal escapes, indented sections, `Index:` with
// no space, `//` in the path); every one of them is now refused by git or named by git.

const ALLOW: PolicyEngineHandle = {
  async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; },
};
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

/** Every path the declaration and the apply are exercised against. */
let repo = '';
/** A directory outside any repository, for diffs that must not depend on one. */
let scratch = '';

const SEED: Record<string, string> = {
  'README':          'r\n',
  'Cargo.lock':      'lock1\n',
  '.env':            'SAFE=1\n',
  'src/app.js':      'x\n',
  'my file.lock':    'm\n',
  '.maf/policy.yaml': 'policy\n',
  'notes':           'n\n',
  'Cargo.lock2':     'l2\n',
  'nothere':         'lock1\n',
  'n.txt':           '-- a/Cargo.lock\n',
  'copy.txt':        'c\n',
  'q"x.lock':        'q\n',
};

function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function seedRepo(root: string): void {
  for (const [name, body] of Object.entries(SEED)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), body, 'utf8');
  }
  assert.equal(git(root, ['init', '-q', '.']).status, 0);
  assert.equal(git(root, ['add', '-A']).status, 0);
  assert.equal(git(root, [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'seed',
  ]).status, 0);
}

/** Back to the seed: tracked files restored, files an apply created removed. */
function resetRepo(): void {
  assert.equal(git(repo, ['reset', '--hard', '-q']).status, 0);
  assert.equal(git(repo, ['clean', '-fdq']).status, 0);
}

before(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'maf-patch-test-'));
  seedRepo(repo);
  scratch = mkdtempSync(path.join(tmpdir(), 'maf-patch-scratch-'));
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function ctxIn(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: repo, projectRoot: repo,
    runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
    sessionId: 's1', agentRole: 'coder',
    policy: ALLOW, attestor: NO_ATTESTOR,
    ...overrides,
  };
}

const tool = new PatchApplyTool();

/** `/`-joined, NFC-normalised, case-folded where the filesystem is: the same key both sides of the comparison. */
function pathKey(p: string): string {
  const normal = p.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32' ? normal.toLowerCase() : normal;
}

interface TreeEntry { sha: string; mode: number }

/** Every file under the root except `.git`, by content and permission bits. */
function snapshot(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : path.join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && entry.name === '.git') continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(root, child);
      if (entry.isDirectory()) { walk(child); continue; }
      const bytes = entry.isSymbolicLink()
        ? Buffer.from(readlinkSync(childAbs), 'utf8')
        : readFileSync(childAbs);
      out.set(pathKey(child), {
        sha: crypto.createHash('sha256').update(bytes).digest('hex'),
        mode: lstatSync(childAbs).mode & 0o777,
      });
    }
  };
  walk('');
  return out;
}

/** The files an apply changed or created, as git's own names would spell them. */
function changedSince(before: Map<string, TreeEntry>): string[] {
  const after = snapshot(repo);
  const changed: string[] = [];
  for (const [key, entry] of after) {
    const was = before.get(key);
    if (was === undefined || was.sha !== entry.sha || was.mode !== entry.mode) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) changed.push(key);
  return changed.sort();
}

const UNIFIED_LOCK = '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n';

// ─── the declaration is git's, not a header parse ───────────────────────────

test('declaredPaths names the file the diff touches, as git names it', () => {
  assert.deepEqual(tool.declaredPaths({ diff: UNIFIED_LOCK }), ['Cargo.lock']);
});

test('declaredPaths lists every file of a multi-file diff', () => {
  const diff = [
    'diff --git a/README b/README',
    '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    'diff --git a/Cargo.lock b/Cargo.lock',
    '--- a/Cargo.lock', '+++ b/Cargo.lock', '@@ -1 +1 @@', '-lock1', '+lock2', '',
  ].join('\n');
  assert.deepEqual(tool.declaredPaths({ diff }).sort(), ['Cargo.lock', 'README']);
});

test('a creation from /dev/null and a deletion both declare the file', () => {
  const create = '--- /dev/null\n+++ b/new.lock\n@@ -0,0 +1 @@\n+new\n';
  const remove = '--- a/notes\n+++ /dev/null\n@@ -1 +0,0 @@\n-n\n';
  assert.deepEqual(tool.declaredPaths({ diff: create }), ['new.lock']);
  assert.deepEqual(tool.declaredPaths({ diff: remove }), ['notes']);
});

test('strip is the same number the apply is given', () => {
  // At `-p0` git keeps the whole name, and `--numstat` reports the side git will write: the new one.
  assert.deepEqual(tool.declaredPaths({ diff: UNIFIED_LOCK, strip: 0 }), ['b/Cargo.lock']);
  assert.deepEqual(tool.declaredPaths({ diff: UNIFIED_LOCK, strip: 1 }), ['Cargo.lock']);
  // Deeper than the name: git cannot name the file, so it cannot declare or apply it.
  assert.throws(() => tool.declaredPaths({ diff: UNIFIED_LOCK, strip: 2 }), ToolDeclarationError);
  // A strip the command would reject is not one the declaration honours either: one value, both uses.
  assert.deepEqual(tool.declaredPaths({ diff: UNIFIED_LOCK, strip: -1 }), ['Cargo.lock']);
  assert.deepEqual(tool.declaredPaths({ diff: UNIFIED_LOCK, strip: 1.5 }), ['Cargo.lock']);
});

test('a diff git cannot read is refused, and says why', () => {
  for (const diff of [
    'just some random text',
    '',
    // `Index:`-only: GNU patch reads it (with `-p0`); git does not, so nothing can be declared.
    'Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    // Normal and ed-style diffs: the tool promises a unified diff and git applies nothing else.
    '1c1\n< r\n---\n> s\n',
    'Index: Cargo.lock\n1c\nlock1\n.\n',
    // A context diff is not a unified diff either; git refuses it rather than guessing.
    '*** a/Cargo.lock\t2026-01-01\n--- b/Cargo.lock\t2026-01-01\n***************\n*** 1 ****\n- lock1\n--- 1 ----\n+ lock2\n',
    // `---<TAB>` with no space after the marker.
    '---\tCargo.lock\n+++\tCargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n',
    // A header with no hunk and no rename names no file git would write.
    'diff --git a/README b/README\n',
  ]) {
    assert.throws(() => tool.declaredPaths({ diff }), ToolDeclarationError, JSON.stringify(diff));
  }
});

test('a diff whose two headers name different files declares the name git will write', () => {
  // git follows the unified `---`/`+++` pair, not the `diff --git` line, when they disagree about
  // which of the two names is the new one. What matters is that the declared set is git's set.
  const oldExists = '--- a/README\n+++ b/Cargo.lock.new\n@@ -1 +1 @@\n-r\n+s\n';
  const newExists = '--- a/nothere\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n';
  assert.deepEqual(tool.declaredPaths({ diff: oldExists }), ['Cargo.lock.new']);
  assert.deepEqual(tool.declaredPaths({ diff: newExists }), ['Cargo.lock']);
});

// ─── forms --numstat alone does not describe ────────────────────────────────

test('a rename is refused, whichever way the diff spells it', () => {
  const pure = 'diff --git a/README b/zz\nsimilarity index 100%\nrename from README\nrename to zz\n';
  assert.throws(() => tool.declaredPaths({ diff: pure }), /refuses this diff: .*rename/);
  // The reported bypass shape: `--numstat` lists only the new name, so a protected file could be
  // renamed away and no `**/*.lock` rule would see it.
  const renameAway = 'diff --git a/Cargo.lock b/away.lock\nsimilarity index 100%\nrename from Cargo.lock\nrename to away.lock\n';
  assert.throws(() => tool.declaredPaths({ diff: renameAway }), /refuses this diff: .*rename/);
  // git decodes the quoted target; the refusal must not depend on the spelling.
  const quoted = 'diff --git a/notes "b/Cargo\\056lock2"\nsimilarity index 100%\nrename from notes\nrename to "Cargo\\056lock2"\n';
  assert.throws(() => tool.declaredPaths({ diff: quoted }), /refuses this diff: .*rename/);
  // `rename to` disagreeing with the `diff --git` b-name is still a rename.
  const mismatch = 'diff --git a/README b/x.txt\nsimilarity index 100%\nrename from README\nrename to Cargo.lock2\n';
  assert.throws(() => tool.declaredPaths({ diff: mismatch }), /refuses this diff: .*rename/);
});

test('a copy is refused', () => {
  const diff = 'diff --git a/copy.txt b/copy2.txt\nsimilarity index 100%\ncopy from copy.txt\ncopy to copy2.txt\n';
  assert.throws(() => tool.declaredPaths({ diff }), /refuses this diff: .*copy/);
});

test('a mode change is refused', () => {
  const diff = 'diff --git a/Cargo.lock b/Cargo.lock\nold mode 100644\nnew mode 100755\n';
  assert.throws(() => tool.declaredPaths({ diff }), /refuses this diff: .*mode change/);
});

test('creating a symlink or a submodule is refused', () => {
  const symlink = 'diff --git a/link b/link\nnew file mode 120000\nindex 0000000..1234567\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n';
  assert.throws(() => tool.declaredPaths({ diff: symlink }), /refuses this diff: .*120000/);
  const submodule = 'diff --git a/sub b/sub\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n';
  assert.throws(() => tool.declaredPaths({ diff: submodule }), /refuses this diff: .*160000/);
});

test('a binary patch is refused: --numstat gives it no line counts to check', () => {
  const dir = mkdtempSync(path.join(scratch, 'binary-'));
  assert.equal(git(dir, ['init', '-q', '.']).status, 0);
  writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  assert.equal(git(dir, ['add', '-A']).status, 0);
  assert.equal(git(dir, [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'binary',
  ]).status, 0);
  writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 3]));
  const diff = git(dir, ['diff', '--binary', '--', 'bin.dat']).stdout;
  assert.match(diff, /GIT binary patch/);
  assert.throws(() => tool.declaredPaths({ diff }), /refuses this diff: .*binary/);
});

// ─── names that are not a path inside the root ──────────────────────────────

test('an absolute, parent-relative or empty name is refused before policy', () => {
  // `a//Cargo.lock` at -p1: git counts a run of slashes as it would several, leaving `/Cargo.lock`.
  const absolute = '--- a//Cargo.lock\n+++ a//Cargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n';
  assert.throws(() => tool.declaredPaths({ diff: absolute }), /refuses this diff: .*absolute/);
  const parent = '--- a/../out.lock\n+++ a/../out.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n';
  assert.throws(() => tool.declaredPaths({ diff: parent }), /refuses this diff: .*\.\./);
});

test('a path into .git is refused as confinement, not as a declaration failure', () => {
  // A verdict the gate records as `builtin:git-dir`; the diff is well formed, the target is not one
  // the tools may write. `refuseGitDirPaths` runs on the paths git itself reported.
  const diff = '--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-x\n+y\n';
  assert.throws(() => tool.declaredPaths({ diff }), PathConfinementError);
});

test('a call with no diff declares nothing and is refused', () => {
  assert.throws(() => tool.declaredPaths({} as unknown as { diff: string }), ToolDeclarationError);
});

// ─── the apply ──────────────────────────────────────────────────────────────

test('execute applies the diff and names the result', async () => {
  resetRepo();
  const before = snapshot(repo);
  const result = await tool.execute({ diff: UNIFIED_LOCK }, ctxIn());
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(changedSince(before), ['cargo.lock']);
  assert.equal(readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'lock2\n');
  assert.equal(typeof result.duration, 'number');
});

test('dryRun checks the diff and changes nothing', async () => {
  resetRepo();
  const before = snapshot(repo);
  const result = await tool.execute({ diff: UNIFIED_LOCK, dryRun: true }, ctxIn());
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'checked 1 file(s)');
  assert.deepEqual(changedSince(before), []);
});

test('a multi-file diff that fails one file changes neither', async () => {
  // git apply is all-or-nothing without `--reject`, and no `--reject` is ever passed (G-P6).
  resetRepo();
  const before = snapshot(repo);
  const diff = [
    'diff --git a/README b/README', '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    'diff --git a/Cargo.lock b/Cargo.lock', '--- a/Cargo.lock', '+++ b/Cargo.lock', '@@ -1 +1 @@', '-nope', '+lock2', '',
  ].join('\n');
  const result = await tool.execute({ diff }, ctxIn());
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), []);
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'r\n');
});

test('a failed apply leaves no .orig, no .rej and no temp file behind', async () => {
  resetRepo();
  const before = snapshot(repo);
  const tmpBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('maf-patch-')).sort();
  const result = await tool.execute({
    diff: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-nope\n+lock2\n',
  }, ctxIn());
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), []);
  const leftovers = readdirSync(repo, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.orig') || name.endsWith('.rej'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith('maf-patch-')).sort(),
    tmpBefore,
    'the temp directory and diff are removed on every path',
  );
});

// ─── the child: flags, environment, and the file it reads ───────────────────

/** A `git` on PATH that records how it was called and then runs the real one. */
function gitShim(): { dir: string; record: string; restore: () => void } {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(real, '', 'git must be on PATH for this test');
  const dir = mkdtempSync(path.join(scratch, 'shim-'));
  const record = path.join(dir, 'calls.txt');
  writeFileSync(record, '');
  const script = path.join(dir, 'git');
  writeFileSync(script, [
    '#!/bin/sh',
    'last=""',
    'for a in "$@"; do last="$a"; done',
    'mode=$(stat -f "%Lp" "$last" 2>/dev/null || stat -c "%a" "$last")',
    `printf 'CALL mode=%s gitdir=%s maf=%s args="%s"\\n' "$mode" "\${GIT_DIR-}" "\${MAF_TOKEN-}" "$*" >> '${record}'`,
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const originalPath = process.env['PATH'] ?? '';
  process.env['PATH'] = `${dir}${path.delimiter}${originalPath}`;
  return {
    dir, record,
    restore: () => { process.env['PATH'] = originalPath; },
  };
}

test('git is run with the two overrides, --recount, the 0600 diff, and nothing from maf\'s environment', async () => {
  // Before the shim is on PATH, so the record holds the tool's calls and nothing else's.
  resetRepo();
  const shim = gitShim();
  const saved = { gitDir: process.env['GIT_DIR'], token: process.env['MAF_TOKEN'] };
  // Both are in the parent's environment and neither may reach the child `toolEnv()` builds.
  process.env['GIT_DIR'] = path.join(scratch, 'not-the-repo');
  process.env['MAF_TOKEN'] = 'shh';
  try {
    const result = await tool.execute({ diff: UNIFIED_LOCK }, ctxIn());
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    shim.restore();
    if (saved.gitDir === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = saved.gitDir;
    if (saved.token === undefined) delete process.env['MAF_TOKEN']; else process.env['MAF_TOKEN'] = saved.token;
  }

  const calls = readFileSync(shim.record, 'utf8').trim().split('\n');
  // numstat, summary, check, apply.
  assert.equal(calls.length, 4, calls.join('\n'));
  for (const call of calls) {
    assert.match(call, /mode=600/, 'the diff file is private to the call that wrote it');
    assert.match(call, /gitdir= /, 'GIT_DIR from maf\'s own environment never reaches the child');
    assert.match(call, /maf= /, 'maf\'s secrets never reach the child');
    assert.match(call, /-c core\.hooksPath=\/dev\/null/);
    assert.match(call, /-c core\.fsmonitor=false/);
    assert.match(call, /apply .*--recount/);
    assert.doesNotMatch(call, /--reject|--3way|--index|--unidiff-zero|-C0/);
  }
  assert.match(calls[0]!, /--numstat -z/);
  assert.match(calls[1]!, /--summary/);
  assert.match(calls[2]!, /--check/);
});

test('a git that cannot be spawned is a refusal, not an exception out of the gate', () => {
  const originalPath = process.env['PATH'] ?? '';
  const empty = mkdtempSync(path.join(scratch, 'empty-path-'));
  process.env['PATH'] = empty;
  try {
    assert.throws(() => tool.declaredPaths({ diff: UNIFIED_LOCK }), /refuses this diff: .*git apply --numstat could not read it/);
  } finally {
    process.env['PATH'] = originalPath;
  }
});

test('a temp directory that cannot be used fails the call before git runs', () => {
  const originalTmp = process.env['TMPDIR'];
  const before = snapshot(repo);
  process.env['TMPDIR'] = path.join(scratch, 'does-not-exist', 'nested');
  try {
    assert.throws(() => tool.declaredPaths({ diff: UNIFIED_LOCK }), /ENOENT|no such file/i);
  } finally {
    if (originalTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = originalTmp;
  }
  assert.deepEqual(changedSince(before), []);
});

test('a declarable diff that does not apply answers with a numeric exit code', async () => {
  // `declaredPaths` succeeded, so the gate ran and executed: the answer is a failed result, and its
  // `exitCode` is a number — never a string errno (G-F3c).
  resetRepo();
  const before = snapshot(repo);
  const result: ToolResult = await tool.execute({
    diff: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-nope\n+lock2\n',
  }, ctxIn());
  assert.equal(typeof result.exitCode, 'number');
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), []);
});
