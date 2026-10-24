import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
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
//
// The round-2 review pins the context those calls share. Every git call is built by
// one function, run in the worktree, handed the same 0600 file by absolute path, and given an empty
// throwaway git directory with the system and global config off — so a repository's filters, hooks
// and fsmonitor cannot reach the write, and a `TMPDIR` inside some repository cannot change the name
// the declaration reports. The declaration also compares `--numstat` in both directions, because
// the forward list names only the destination of a rename that did not say it was one.

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

/**
 * The context a gated call arrives in: the gate's declaration travels on it as `approvedPaths`
 * (L1). A call that reaches `execute` without one is refused, so every apply test goes through here.
 */
function gatedCtx(input: { diff: string; strip?: number }, overrides: Partial<ToolContext> = {}): ToolContext {
  return ctxIn({ approvedPaths: tool.declaredPaths(input, ctxIn()), ...overrides });
}

/** `execute`, with the context a gated call would have given it. */
function executeGated(input: { diff: string; strip?: number; dryRun?: boolean }, overrides: Partial<ToolContext> = {}): Promise<ToolResult> {
  return tool.execute(input, gatedCtx(input, overrides));
}

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
  const result = await executeGated({ diff: UNIFIED_LOCK });
  assert.equal(result.exitCode, 0, result.stderr);
  // The expectation goes through `pathKey` too: on Linux the file is `Cargo.lock`, and a literal
  // lower-case name here is a Mac-only count (HP2/HS2).
  assert.deepEqual(changedSince(before), [pathKey('Cargo.lock')]);
  assert.equal(readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'lock2\n');
  assert.equal(typeof result.duration, 'number');
});

test('dryRun checks the diff and changes nothing', async () => {
  resetRepo();
  const before = snapshot(repo);
  const result = await executeGated({ diff: UNIFIED_LOCK, dryRun: true });
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
  const result = await executeGated({ diff });
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), []);
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'r\n');
});

test('a failed apply leaves no .orig, no .rej and no temp file behind', async () => {
  resetRepo();
  const before = snapshot(repo);
  // A private TMPDIR for this test only (HS12): listing the machine's shared temp directory made
  // the assertion depend on what every other test and every other process on the machine was doing,
  // so a sibling's leftover could fail it and this test's own leftover could hide in the crowd.
  const savedTmp = process.env['TMPDIR'];
  const ownTmp = mkdtempSync(path.join(scratch, 'tmp-isolated-'));
  process.env['TMPDIR'] = ownTmp;
  let leftovers: string[] = [];
  try {
    const result = await executeGated({
      diff: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-nope\n+lock2\n',
    });
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(changedSince(before), []);
    leftovers = readdirSync(repo, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.orig') || name.endsWith('.rej'));
  } finally {
    if (savedTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = savedTmp;
  }
  assert.deepEqual(leftovers, []);
  assert.deepEqual(readdirSync(ownTmp), [], 'the temp directory and diff are removed on every path');
  rmSync(ownTmp, { recursive: true, force: true });
});

// ─── round 2: both sides of the name, links, strictness ─────────────────────

/**
 * The shape that made HP1 possible: a `diff --git` header naming two files with no `rename from/to`
 * lines. git deletes the old file and writes the new one, and `--numstat` reports only the new name.
 */
function implicitRename(from: string, to: string): string {
  return `diff --git a/${from} b/${to}\n--- a/${from}\n+++ b/${to}\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n`;
}

test('a section whose two names differ without saying rename is refused (HP1)', () => {
  for (const [from, to] of [
    ['.env', 'notes.txt'],
    ['Cargo.lock', 'away.lock'],
    ['.maf/policy.yaml', 'x.txt'],
  ] as const) {
    assert.throws(
      () => tool.declaredPaths({ diff: implicitRename(from, to) }),
      (err: unknown) => err instanceof ToolDeclarationError
        && err.message.includes(`git names "${from}" on the old side and "${to}" on the new`),
      `${from} -> ${to}`,
    );
  }
});

test('a normal git diff read at -p0 is refused, because its two sides are a/ and b/ (HP1)', () => {
  const diff = [
    'diff --git a/README b/README', 'index 1111111..2222222 100644',
    '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s', '',
  ].join('\n');
  // At -p0 git keeps the `a/` and `b/` prefixes, so the old and new names differ without a rename.
  assert.throws(() => tool.declaredPaths({ diff, strip: 0 }), /old side/);
  // At the default -p1 the same bytes name one file in both directions.
  assert.deepEqual(tool.declaredPaths({ diff }), ['README']);
});

test('a deletion is a plain delete: one name both directions, so it is declared (HP1)', () => {
  const diff = '--- a/Cargo.lock\n+++ /dev/null\n@@ -1 +0,0 @@\n-lock1\n';
  assert.deepEqual(tool.declaredPaths({ diff }), ['Cargo.lock']);
});

test('a patch to a path that is currently a symlink is refused, and the link is untouched (HP4)', async () => {
  resetRepo();
  const link = path.join(repo, 'linked.lock');
  rmSync(link, { force: true });
  symlinkSync('.env', link);
  try {
    // The declared name is the link; the policy sees `.env`, which is what it points at today, so
    // a rewrite of the link would land in a file the policy was never asked about.
    const diff = '--- a/linked.lock\n+++ b/linked.lock\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n';
    // HS23: refused at declaration time too, so the gate records a Deny rather than an Allow the
    // call then fails under.
    assert.throws(() => tool.declaredPaths({ diff }, ctxIn()), /symbolic link/);
    // The gate would have refused before `execute`; the approved set is named here so the second
    // pass is what runs, and it reaches the link walk.
    await assert.rejects(() => tool.execute({ diff }, ctxIn({ approvedPaths: ['linked.lock'] })), /symbolic link/);
    assert.equal(readlinkSync(link), '.env');
    assert.equal(readFileSync(path.join(repo, '.env'), 'utf8'), 'SAFE=1\n');
  } finally {
    rmSync(link, { force: true });
  }
});

test('two files concatenated by diff -u apply as one patch, without --recount (HP5)', async () => {
  resetRepo();
  const before = snapshot(repo);
  const diff = UNIFIED_LOCK + '--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n+s\n';
  const result = await executeGated({ diff });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(changedSince(before), [pathKey('Cargo.lock'), pathKey('README')].sort());
  assert.equal(readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'lock2\n');
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 's\n');
});

test('an indented section header is refused rather than silently skipped (HP6)', () => {
  const whole = [
    ' diff --git a/Cargo.lock b/Cargo.lock', ' --- a/Cargo.lock', ' +++ b/Cargo.lock',
    ' @@ -1 +1 @@', ' -lock1', ' +lock2', '',
  ].join('\n');
  const second = [
    '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    ' diff --git a/Cargo.lock b/Cargo.lock', '--- a/Cargo.lock', '+++ b/Cargo.lock',
    '@@ -1 +1 @@', '-lock1', '+lock2', '',
  ].join('\n');
  // The line named is the first line git skips: line 1 when the whole diff is indented, line 6
  // when only the second section is.
  for (const [diff, line] of [[whole, 1], [second, 6]] as const) {
    assert.throws(
      () => tool.declaredPaths({ diff }),
      new RegExp(`line ${line} is .*, and that is neither a section header`),
      JSON.stringify(diff),
    );
  }
});

test('no filter, hook or fsmonitor named in repository configuration can run (HP3)', async () => {
  resetRepo();
  const marker = path.join(scratch, `ran-${process.pid}.txt`);
  rmSync(marker, { force: true });
  const hooks = mkdtempSync(path.join(scratch, 'hooks-'));
  const fakeGlobal = path.join(scratch, 'fake-global-gitconfig');
  const savedGlobal = process.env['GIT_CONFIG_GLOBAL'];
  // 1. A filter in the repository's own config, selected by a file the patch writes.
  writeFileSync(path.join(repo, '.gitattributes'), 'Cargo.lock filter=evil\n');
  assert.equal(git(repo, ['config', 'filter.evil.clean', `sh -c 'echo CLEAN >> ${marker}; cat'`]).status, 0);
  assert.equal(git(repo, ['config', 'filter.evil.smudge', `sh -c 'echo SMUDGE >> ${marker}; cat'`]).status, 0);
  // 2. A hook directory and an fsmonitor program, both named in the repository's own config.
  writeFileSync(path.join(hooks, 'applypatch-msg'), `#!/bin/sh\necho HOOK >> '${marker}'\n`, { mode: 0o755 });
  writeFileSync(path.join(hooks, 'post-index-change'), `#!/bin/sh\necho HOOK >> '${marker}'\n`, { mode: 0o755 });
  assert.equal(git(repo, ['config', 'core.hooksPath', hooks]).status, 0);
  const fsmon = path.join(scratch, 'fsmonitor.sh');
  writeFileSync(fsmon, `#!/bin/sh\necho FSMON >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  assert.equal(git(repo, ['config', 'core.fsmonitor', fsmon]).status, 0);
  // 3. A global config of the user's, with a filter of the same name.
  writeFileSync(fakeGlobal, `[filter "evil"]\n\tclean = sh -c 'echo GLOBAL >> ${marker}; cat'\n`);
  process.env['GIT_CONFIG_GLOBAL'] = fakeGlobal;
  try {
    const result = await executeGated({ diff: UNIFIED_LOCK });
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    if (savedGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = savedGlobal;
    git(repo, ['config', '--unset', 'filter.evil.clean']);
    git(repo, ['config', '--unset', 'filter.evil.smudge']);
    git(repo, ['config', '--unset', 'core.hooksPath']);
    git(repo, ['config', '--unset', 'core.fsmonitor']);
    rmSync(hooks, { recursive: true, force: true });
    rmSync(fakeGlobal, { force: true });
  }
  assert.equal(existsSync(marker), false, 'nothing a filter, hook or fsmonitor would have run did run');
  assert.equal(readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'lock2\n');
  resetRepo();
});

test('a TMPDIR inside a repository does not change the path declared or written (HS1)', async () => {
  resetRepo();
  const savedTmp = process.env['TMPDIR'];
  const nested = path.join(repo, 'tmpdir');
  mkdirSync(nested, { recursive: true });
  process.env['TMPDIR'] = nested;
  try {
    // The diff file now lives inside the repository. Before the sealed context, git ran the
    // declaration there and reported `tmpdir/maf-patch-…/.maf/policy.yaml`, while the apply wrote
    // `.maf/policy.yaml` — a Deny rule on the real name never fired.
    const diff = '--- a/.maf/policy.yaml\n+++ b/.maf/policy.yaml\n@@ -1 +1 @@\n-policy\n+changed\n';
    assert.deepEqual(tool.declaredPaths({ diff }), ['.maf/policy.yaml']);
    const result = await executeGated({ diff });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readFileSync(path.join(repo, '.maf/policy.yaml'), 'utf8'), 'changed\n');
    assert.equal(existsSync(path.join(nested, '.maf')), false, 'nothing was written relative to TMPDIR');
  } finally {
    if (savedTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = savedTmp;
    rmSync(nested, { recursive: true, force: true });
  }
  resetRepo();
});

test('dryRun where the diff does not apply fails non-zero, and git was asked (HP8)', async () => {
  resetRepo();
  const before = snapshot(repo);
  // Declared before the shim is on PATH: the record holds the apply's calls only.
  const input = { diff: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-nope\n+lock2\n', dryRun: true };
  const approved = tool.declaredPaths(input, ctxIn());
  const shim = gitShim();
  try {
    const result = await tool.execute(input, ctxIn({ approvedPaths: approved }));
    assert.notEqual(result.exitCode, 0, 'a dry run that would fail must not answer success');
  } finally {
    shim.restore();
  }
  const calls = readFileSync(shim.record, 'utf8').trim().split('\n');
  assert.equal(calls.length, 4, calls.join('\n'));
  assert.match(calls[3]!, /apply -p1 --check /, 'the dry run asks git, and asks it with --check');
  assert.deepEqual(changedSince(before), []);
  rmSync(shim.dir, { recursive: true, force: true });
});

// ─── the child: flags, environment, and the file it reads ───────────────────

/**
 * A `git` on PATH that records how it was called and then runs the real one.
 *
 * `stat` is done by node rather than by `stat(1)`: BSD and GNU spell the format differently
 * (`stat -f "%Lp"` against `stat -c "%a"`), and the old `a || b` fallback read as a Mac-only test
 * — on Linux the first form exits 0 having printed nothing useful (HP2/HS2).
 */
function gitShim(failWhen?: string): { dir: string; record: string; restore: () => void } {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(real, '', 'git must be on PATH for this test');
  const dir = mkdtempSync(path.join(scratch, 'shim-'));
  const record = path.join(dir, 'calls.txt');
  writeFileSync(record, '');
  const script = path.join(dir, 'git');
  // Double quotes only: the script sits inside single quotes in the sh wrapper.
  const modeOf = 'const fs=require("node:fs");'
    + 'try{process.stdout.write((fs.statSync(process.argv[1]).mode&0o777).toString(8))}'
    + 'catch{process.stdout.write("?")}';
  writeFileSync(script, [
    '#!/bin/sh',
    'last=""',
    'for a in "$@"; do last="$a"; done',
    `mode=$(node -e '${modeOf}' "$last")`,
    `printf 'CALL mode=%s gitdir=%s wt=%s nss=%s ngl=%s maf=%s cwd=%s file=%s args="%s"\\n' `
      + `"$mode" "\${GIT_DIR-}" "\${GIT_WORK_TREE-}" "\${GIT_CONFIG_NOSYSTEM-}" "\${GIT_CONFIG_GLOBAL-}" `
      + `"\${MAF_TOKEN-}" "$(pwd)" "$last" "$*" >> '${record}'`,
    // A shim that fails one subcommand only: `--summary` succeeding and `--numstat` failing is the
    // shape no real git produces, which is exactly what HS22's unreached guard needs.
    ...(failWhen === undefined ? [] : [
      `case "$*" in *${failWhen}*) echo 'shim: ${failWhen} unavailable' >&2; exit 1 ;; esac`,
    ]),
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

/** One recorded field, by name, up to the next space. */
function callField(call: string, name: string): string {
  return new RegExp(`(?:^| )${name}=([^ ]*)`).exec(call)?.[1] ?? '';
}

test('every git call shares one sealed context, one diff file, and no --recount', async () => {
  // Before the shim is on PATH, so the record holds the tool's calls and nothing else's.
  resetRepo();
  const approved = tool.declaredPaths({ diff: UNIFIED_LOCK }, ctxIn());
  const shim = gitShim();
  const saved = { gitDir: process.env['GIT_DIR'], token: process.env['MAF_TOKEN'] };
  // Both are in the parent's environment and neither may reach the child `toolEnv()` builds.
  process.env['GIT_DIR'] = path.join(scratch, 'not-the-repo');
  process.env['MAF_TOKEN'] = 'shh';
  try {
    const result = await tool.execute({ diff: UNIFIED_LOCK }, ctxIn({ approvedPaths: approved }));
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    shim.restore();
    if (saved.gitDir === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = saved.gitDir;
    if (saved.token === undefined) delete process.env['MAF_TOKEN']; else process.env['MAF_TOKEN'] = saved.token;
  }

  const calls = readFileSync(shim.record, 'utf8').trim().split('\n');
  // summary, forward numstat, reverse numstat, check, apply — five calls, one context.
  assert.equal(calls.length, 5, calls.join('\n'));
  const files = new Set(calls.map((call) => callField(call, 'file')));
  assert.equal(files.size, 1, 'every call is handed the same diff file');
  for (const call of calls) {
    assert.match(call, /mode=600/, 'the diff file is private to the call that wrote it');
    assert.match(callField(call, 'gitdir'), /maf-gitdir-/, 'GIT_DIR is the empty throwaway directory');
    assert.doesNotMatch(call, /not-the-repo/, 'GIT_DIR from maf\'s own environment never reaches the child');
    assert.equal(callField(call, 'wt'), repo, 'the worktree is the project root, not the temp folder (HS1)');
    assert.equal(callField(call, 'nss'), '1');
    assert.equal(callField(call, 'ngl'), '/dev/null');
    assert.equal(callField(call, 'cwd'), repo, 'the child runs in the worktree, so patch paths are relative to it');
    assert.equal(callField(call, 'maf'), '', 'maf\'s secrets never reach the child');
    assert.match(call, /-c core\.hooksPath=\/dev\/null/);
    assert.match(call, /-c core\.fsmonitor=false/);
    assert.match(call, /-c core\.attributesFile=\/dev\/null/);
    assert.match(call, /apply -p1 /, 'the declaration and the apply are given the same strip');
    assert.doesNotMatch(call, /--recount/, '--recount breaks an ordinary multi-file `diff -u` (HP5)');
    assert.doesNotMatch(call, /--reject|--3way|--index|--unidiff-zero|-C0/);
  }
  assert.match(calls[0]!, /apply -p1 --summary /);
  assert.match(calls[1]!, /apply -p1 --numstat -z /);
  assert.doesNotMatch(calls[1]!, /-R /, 'the forward list is the forward list');
  assert.match(calls[2]!, /apply -p1 -R --numstat -z /, 'the old side is read too (HP1)');
  assert.match(calls[3]!, /apply -p1 --check /);
  assert.doesNotMatch(calls[4]!, /--summary|--numstat|--check/, 'the write is the plain apply');
  rmSync(shim.dir, { recursive: true, force: true });
});

test('a git that cannot be spawned is a refusal, not an exception out of the gate', () => {
  const originalPath = process.env['PATH'] ?? '';
  const empty = mkdtempSync(path.join(scratch, 'empty-path-'));
  process.env['PATH'] = empty;
  try {
    assert.throws(() => tool.declaredPaths({ diff: UNIFIED_LOCK }), /refuses this diff: .*could not read it/);
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
  const result: ToolResult = await executeGated({
    diff: '--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-nope\n+lock2\n',
  });
  assert.equal(typeof result.exitCode, 'number');
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), []);
});

// ─── round 3: R2-M1, R2-L1, R2-L2, R2-H1/HS18 ──────────────────────────────

test('a YAML context line that reads like a section header no longer refuses the diff (R2-M1)', async () => {
  // `helm template` emits `--- # Source: chart/a.yaml` as a document separator; in a diff it is a
  // context line, so it arrives as a space followed by that text. The round-2 pattern refused any
  // indented `--- `, which made every such file unpatchable.
  resetRepo();
  writeFileSync(path.join(repo, 'k.yaml'), '--- # Source: chart/a.yaml\nkind: A\nx: 1\n', 'utf8');
  const before = snapshot(repo);
  const diff = [
    '--- a/k.yaml', '+++ b/k.yaml', '@@ -1,3 +1,3 @@',
    ' --- # Source: chart/a.yaml', ' kind: A', '-x: 1', '+x: 2', '',
  ].join('\n');

  assert.deepEqual(tool.declaredPaths({ diff }), ['k.yaml'], 'the context line is not a section');
  const result = await executeGated({ diff });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(changedSince(before), [pathKey('k.yaml')]);
  assert.equal(readFileSync(path.join(repo, 'k.yaml'), 'utf8'), '--- # Source: chart/a.yaml\nkind: A\nx: 2\n');
  resetRepo();
});

test('an indented ---/+++ pair is still refused, with no diff --git line (R2-M1)', () => {
  // The line grammar must not lose the case the pattern was written for: an indented `---`
  // immediately followed by an indented `+++` at the same indent is a section git silently skips.
  const pair = [
    '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    ' --- a/Cargo.lock', ' +++ b/Cargo.lock', ' @@ -1 +1 @@', ' -lock1', ' +lock2', '',
  ].join('\n');
  assert.throws(() => tool.declaredPaths({ diff: pair }), /line 6 is " --- a\/Cargo.lock"/);
});

test('a git that cannot answer --numstat is refused even when --summary passed (HS22)', () => {
  // The `--numstat` guard was defence in depth no test reached: on every input `--numstat` fails
  // on, `--summary` fails first. This shim fails only `--numstat`, so the guard is now exercised.
  resetRepo();
  const shim = gitShim('--numstat');
  try {
    assert.throws(() => tool.declaredPaths({ diff: UNIFIED_LOCK }), /--numstat could not read it/);
  } finally {
    shim.restore();
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test('a path whose name is too long to check is refused, not thrown raw (R2-L1)', () => {
  // `lstat` of a component over NAME_MAX throws `ENAMETOOLONG`, which used to escape `execute` as a
  // raw `Error`; it is now a declaration refusal, which the gate records as a Deny.
  const long = `${'a'.repeat(400)}.txt`;
  const diff = `--- a/${long}\n+++ b/${long}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.throws(
    () => tool.declaredPaths({ diff }, ctxIn()),
    (err: unknown) => err instanceof ToolDeclarationError && /checking that path failed/.test(err.message),
  );
});

test('a write below a path that is a regular file is refused at declaration, before anything is written (HS24)', () => {
  // `README/x` passes `git apply --check` — the diff parses — and the apply then fails partway
  // through, after a multi-file patch has already written the files before it. A parent component
  // that exists and is not a directory is refused at declaration, so the call never runs.
  resetRepo();
  const diff = '--- /dev/null\n+++ b/README/x\n@@ -0,0 +1 @@\n+new\n';
  assert.throws(
    () => tool.declaredPaths({ diff }, ctxIn()),
    (err: unknown) => err instanceof ToolDeclarationError
      && /"README" is a regular file rather than a directory/.test(err.message),
  );
});

test('a two-file diff with a path below a regular file is refused in either order, and the tree is byte-identical (HS24)', async () => {
  // The measured harm: `README/x` alone fails cleanly, but with a good file beside it the apply
  // writes the first file and *then* fails on the second (exit 128), so the tree is left half
  // changed under a call the policy allowed. Both orders are tested because the order decides which
  // harm was measured — the good file first (a partial write) and the bad file first.
  const good = ['diff --git a/notes b/notes', '--- a/notes', '+++ b/notes', '@@ -1 +1 @@', '-n', '+changed'];
  const bad = ['diff --git a/README b/README/x', 'new file mode 100644', '--- /dev/null', '+++ b/README/x',
    '@@ -0,0 +1 @@', '+new'];
  for (const [name, lines] of [['good first', [...good, ...bad]], ['bad first', [...bad, ...good]]] as const) {
    resetRepo();
    const before = snapshot(repo);
    const diff = `${lines.join('\n')}\n`;
    assert.throws(
      () => tool.declaredPaths({ diff }, ctxIn()),
      (err: unknown) => err instanceof ToolDeclarationError
        && /"README" is a regular file rather than a directory/.test(err.message),
      `${name}: the declaration refuses it`,
    );
    await assert.rejects(
      // The declaration the gate would have produced, named literally: the gate itself refuses this
      // diff, so this exercises `execute`'s own walk with an approved set that matches.
      () => tool.execute({ diff }, ctxIn({ approvedPaths: ['README/x', 'notes'] })),
      (err: unknown) => err instanceof ToolDeclarationError
        && /"README" is a regular file rather than a directory/.test(err.message),
      `${name}: execute refuses it too`,
    );
    assert.deepEqual(changedSince(before), [], `${name}: nothing was written`);
    assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'r\n', `${name}: README is untouched`);
    assert.equal(readFileSync(path.join(repo, 'notes'), 'utf8'), 'n\n', `${name}: notes is untouched`);
  }
});

test('a write through a symlinked parent directory is refused at declaration time, naming the link (R2-L2)', async () => {
  // `d -> src` makes `d/new.js` a write through a link. git's own "affected file is beyond a
  // symbolic link" came only after the policy had allowed the call; the declaration now refuses it,
  // so the gate records a Deny, and `execute` refuses again for a link created after the gate.
  resetRepo();
  const link = path.join(repo, 'd');
  rmSync(link, { force: true });
  symlinkSync('src', link);
  try {
    const diff = '--- /dev/null\n+++ b/d/new.js\n@@ -0,0 +1 @@\n+new\n';
    assert.throws(
      () => tool.declaredPaths({ diff }, ctxIn()),
      /through "d", which is a symbolic link/,
    );
    await assert.rejects(() => tool.execute({ diff }, ctxIn({ approvedPaths: ['d/new.js'] })), /symbolic link/);
    assert.equal(existsSync(path.join(repo, 'src', 'new.js')), false, 'nothing was written through the link');
  } finally {
    rmSync(link, { force: true });
  }
});

test('execute refuses when the policy approved a different set of paths (R2-H1)', async () => {
  // The minimum the round-3 ruling requires: `execute` recomputes the declaration in the context it
  // writes from, and a set that differs in any way from the approved set is refused. The mutant —
  // add one path to the approved side — must be refused, with nothing written.
  resetRepo();
  const before = snapshot(repo);
  const approved = [...tool.declaredPaths({ diff: UNIFIED_LOCK }, ctxIn()), 'extra.txt'];
  await assert.rejects(
    () => tool.execute({ diff: UNIFIED_LOCK }, ctxIn({ approvedPaths: approved })),
    (err: unknown) => err instanceof ToolDeclarationError && /the policy approved/.test(err.message),
  );
  assert.deepEqual(changedSince(before), [], 'a refused call writes nothing');
  assert.equal(readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'lock1\n');
});

test('the paths the gate declares are the paths the apply writes, for every diff shape (R2-H1/HS18)', async () => {
  // The differential, in miniature: for each shape, the declaration the gate computes is the one
  // `execute` accepts. A tool that disagreed with its own gate would refuse its own approved call.
  const twoFiles = [
    'diff --git a/README b/README', '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    'diff --git a/Cargo.lock b/Cargo.lock', '--- a/Cargo.lock', '+++ b/Cargo.lock',
    '@@ -1 +1 @@', '-lock1', '+lock2', '',
  ].join('\n');
  const yaml = [
    '--- a/k.yaml', '+++ b/k.yaml', '@@ -1,3 +1,3 @@',
    ' --- # Source: chart/a.yaml', ' kind: A', '-x: 1', '+x: 2', '',
  ].join('\n');
  const diffs: Array<[string, string, () => void]> = [
    ['content edit', UNIFIED_LOCK, () => undefined],
    ['creation', '--- /dev/null\n+++ b/made.txt\n@@ -0,0 +1 @@\n+new\n', () => undefined],
    ['deletion', '--- a/notes\n+++ /dev/null\n@@ -1 +0,0 @@\n-n\n', () => undefined],
    ['two files', twoFiles, () => undefined],
    ['yaml context', yaml, () => writeFileSync(path.join(repo, 'k.yaml'), '--- # Source: chart/a.yaml\nkind: A\nx: 1\n', 'utf8')],
  ];
  try {
    for (const [name, diff, setUp] of diffs) {
      resetRepo();
      setUp();   // `resetRepo` cleans untracked files, so the fixture is written after it
      const gate = tool.declaredPaths({ diff }, ctxIn());
      assert.deepEqual(tool.declaredPaths({ diff }), gate, `${name}: the declaration is a pure function of the diff`);
      const result = await tool.execute({ diff }, ctxIn({ approvedPaths: gate }));
      assert.equal(result.exitCode, 0, `${name}: ${result.stderr}`);
    }
  } finally {
    resetRepo();
  }
});

// ─── round 4: L1, L2 ────────────────────────────────────────────────────────

test('execute refuses a call that arrives without the approved set (L1)', async () => {
  // A write is made through the gate, on the paths the gate approved. A direct call that names no
  // approved set has nothing to check itself against, so it is refused rather than trusted.
  resetRepo();
  const before = snapshot(repo);
  await assert.rejects(
    () => tool.execute({ diff: UNIFIED_LOCK }, ctxIn()),
    (err: unknown) => err instanceof ToolDeclarationError
      && /arrived without the paths the policy approved/.test(err.message),
  );
  assert.deepEqual(changedSince(before), [], 'a refused call writes nothing');
});

test('the eight shapes git applies in part and exits 0 are refused, naming the line (L2)', async () => {
  // git's apply reads as much of a diff as it understands and silently skips the rest, exiting 0.
  // A section whose hunk header or body is moved a character out of column one is skipped whole —
  // measured below against git itself — so the apply would report a file it never touched. Every
  // line must be one git reads, and a line that is not is named.
  const good = ['--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s'];
  const env = ['--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-SAFE=1', '+LEAK=1'];
  const marked = (mark: string, at: readonly number[]): string[] =>
    env.map((line, i) => (at.includes(i) ? mark + line : line));
  const shapes: Array<[string, string[]]> = [
    ['a space before the hunk header', marked(' ', [2])],
    ['a space before every line', marked(' ', [0, 1, 2, 3, 4])],
    ['a space before the headers and the hunk header', marked(' ', [0, 1, 2])],
    ['a tab before the hunk header', marked('\t', [2])],
    ['a tab before every line', marked('\t', [0, 1, 2, 3, 4])],
    ['a no-break space before the hunk header', marked('\u00a0', [2])],
    ['a no-break space before every line', marked('\u00a0', [0, 1, 2, 3, 4])],
    ['a carriage return before every line', marked('\r', [0, 1, 2, 3, 4])],
  ];
  resetRepo();
  const before = snapshot(repo);
  for (const [name, second] of shapes) {
    const diff = `${[...good, ...second].join('\n')}\n`;
    // The behaviour this refuses: git checks and applies the first section, skips the second whole,
    // and exits 0 — so `--numstat` names only README and `.env` would be reported untouchable
    // while nothing says so.
    const checked = spawnSync('git', ['apply', '--check', '-'], { cwd: repo, input: diff, encoding: 'utf8' });
    assert.equal(checked.status, 0, `${name}: git accepts this diff (${checked.stderr})`);
    assert.throws(
      () => tool.declaredPaths({ diff }, ctxIn()),
      (err: unknown) => err instanceof ToolDeclarationError && /line \d+ is /.test(err.message),
      name,
    );
    await assert.rejects(() => tool.execute({ diff }, ctxIn({ approvedPaths: [] })), /line \d+ is /, name);
    assert.deepEqual(changedSince(before), [], `${name}: nothing is written`);
  }
});

test('a hunk with more body lines than its header counts is refused, naming the overflow (L2)', () => {
  // The surviving mutant was the `oldLeft < 0 || newLeft < 0` guard: without it an extra removed
  // line past the hunk's count is read as a body line, and the next real header is read as more body.
  // git corrupts on it (`corrupt patch at line 7`); the grammar names the line instead.
  const diff = '--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n-extra\n+s\n';
  assert.throws(
    () => tool.declaredPaths({ diff }, ctxIn()),
    (err: unknown) => err instanceof ToolDeclarationError
      && /more lines than its hunk header counts/.test(err.message),
  );
});

test('the grammar accepts what git applies in full: empty-line context, a `diff` command line, a CRLF blank (R4-M1)', async () => {
  // Three shapes git reads to the end and applies, which the round-4 grammar refused. Each is run
  // through the real gate end to end, and git's own `--check` is asserted to pass on it first, so the
  // test proves the grammar accepts exactly what git applies — not a shape this tool happens to like.
  const cases: ReadonlyArray<{ name: string; seed: Record<string, string>; diff: string; wrote: string[] }> = [
    {
      name: 'an empty line inside a hunk is blank context',
      // `blank.txt` holds `one\n\nthree\n`; the context line for the blank is written empty, no space.
      seed: { 'blank.txt': 'one\n\nthree\n' },
      diff: '--- a/blank.txt\n+++ b/blank.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n\n three\n',
      wrote: ['blank.txt'],
    },
    {
      name: 'a `diff -ruN` command line is a header that names nothing',
      seed: { 'f.txt': 'one\ntwo\nthree\n' },
      diff: 'diff -ruN a/f.txt b/f.txt\n--- a/f.txt\t2020-01-01 00:00:00\n+++ b/f.txt\t2020-01-01 00:00:01\n@@ -1,3 +1,3 @@\n-one\n+ONE\n two\n three\n',
      wrote: ['f.txt'],
    },
    {
      name: 'a lone CR between files in a CRLF diff is the blank separator',
      seed: { 'c1.txt': 'x1\r\n', 'c2.txt': 'y1\r\n' },
      diff: '--- a/c1.txt\r\n+++ b/c1.txt\r\n@@ -1 +1 @@\r\n-x1\r\n+X1\r\n\r\n--- a/c2.txt\r\n+++ b/c2.txt\r\n@@ -1 +1 @@\r\n-y1\r\n+Y1\r\n',
      wrote: ['c1.txt', 'c2.txt'],
    },
  ];
  for (const { name, seed, diff, wrote } of cases) {
    const dir = mkdtempSync(path.join(scratch, 'r4m1-'));
    for (const [n, b] of Object.entries(seed)) writeFileSync(path.join(dir, n), b);
    assert.equal(git(dir, ['init', '-q', '.']).status, 0, name);
    assert.equal(git(dir, ['add', '-A']).status, 0, name);
    assert.equal(git(dir, [
      '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 's',
    ]).status, 0, name);
    // git itself applies this diff in full.
    const checked = spawnSync('git', ['apply', '--check', '-'], { cwd: dir, input: diff, encoding: 'utf8' });
    assert.equal(checked.status, 0, `${name}: git accepts it (${checked.stderr})`);

    const ctx = ctxIn({ cwd: dir, projectRoot: dir });
    const declared = tool.declaredPaths({ diff }, ctx);
    assert.deepEqual([...declared].sort(), [...wrote].sort(), name);
    const result = await tool.execute({ diff }, ctxIn({ cwd: dir, projectRoot: dir, approvedPaths: declared }));
    assert.equal(result.exitCode, 0, `${name}: the apply succeeds (${result.stderr})`);
  }
});

test('a `GIT binary patch` line is refused wherever it appears, and the tree is unchanged (R4-H2)', async () => {
  // Binary patches are already refused from `--numstat`'s `-` counts, but a lone marker line after a
  // text hunk let the grammar read a text section and then stop checking at the marker — so a hidden
  // `.env` section below it would never be seen. The marker is refused by its own line now.
  resetRepo();
  const before = snapshot(repo);
  const diff = '--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n+s\nGIT binary patch\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n';
  assert.throws(
    () => tool.declaredPaths({ diff }, ctxIn()),
    (err: unknown) => err instanceof ToolDeclarationError && /"GIT binary patch" marker/.test(err.message),
  );
  await assert.rejects(
    () => tool.execute({ diff }, ctxIn({ approvedPaths: [] })),
    (err: unknown) => err instanceof ToolDeclarationError && /"GIT binary patch" marker/.test(err.message),
  );
  assert.deepEqual(changedSince(before), [], 'nothing is written, README included');
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'r\n');
  assert.equal(readFileSync(path.join(repo, '.env'), 'utf8'), 'SAFE=1\n');
});

test('a hunk aimed at an existing directory is refused: git exits 0 having written nothing (R4-H1)', async () => {
  // `git apply --check` passes on `--- a/dir / +++ b/dir`, and the apply exits 0 with
  // `warning: unable to rmdir 'dir'` having changed nothing — so the agent would be told the hunk
  // landed. The declaration refuses the directory name.
  const dir = mkdtempSync(path.join(scratch, 'dirtarget-'));
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'a.txt'), 'inside\n');
  assert.equal(git(dir, ['init', '-q', '.']).status, 0);
  assert.equal(git(dir, ['add', '-A']).status, 0);
  assert.equal(git(dir, [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 's',
  ]).status, 0);
  const ctx = ctxIn({ cwd: dir, projectRoot: dir });
  const diff = '--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-inside\n+changed\n';
  // git accepts the check and exits 0 writing nothing — the false "applied" this refusal closes.
  assert.equal(spawnSync('git', ['apply', '--check', '-'], { cwd: dir, input: diff, encoding: 'utf8' }).status, 0);
  assert.throws(
    () => tool.declaredPaths({ diff }, ctx),
    (err: unknown) => err instanceof ToolDeclarationError && /which is an existing directory/.test(err.message),
  );
  await assert.rejects(
    () => tool.execute({ diff }, ctxIn({ cwd: dir, projectRoot: dir, approvedPaths: ['sub'] })),
    (err: unknown) => err instanceof ToolDeclarationError && /which is an existing directory/.test(err.message),
  );
});

test('a file replaced by a directory in one diff is allowed: git deletes the file, then writes beneath it (R4-H1 LOW)', async () => {
  // `x` is a regular file; the diff deletes `x` and creates `x/y`. git removes `x` first, then writes
  // `x/y`, and the whole patch applies (measured: exit 0, `x` becomes a directory). A deleted prefix
  // must not be treated as a regular-file parent to refuse under.
  const dir = mkdtempSync(path.join(scratch, 'filetodir-'));
  writeFileSync(path.join(dir, 'x'), 'filex\n');
  writeFileSync(path.join(dir, 'README'), 'r\n');
  assert.equal(git(dir, ['init', '-q', '.']).status, 0);
  assert.equal(git(dir, ['add', '-A']).status, 0);
  assert.equal(git(dir, [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 's',
  ]).status, 0);
  const ctx = ctxIn({ cwd: dir, projectRoot: dir });
  const diff = 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-filex\n'
    + 'diff --git a/x/y b/x/y\nnew file mode 100644\n--- /dev/null\n+++ b/x/y\n@@ -0,0 +1 @@\n+ynew\n';
  const declared = tool.declaredPaths({ diff }, ctx);
  assert.deepEqual([...declared].sort(), ['x', 'x/y'], 'both the deleted file and the created one are declared');
  const result = await tool.execute({ diff }, ctxIn({ cwd: dir, projectRoot: dir, approvedPaths: declared }));
  assert.equal(result.exitCode, 0, `the apply succeeds (${result.stderr})`);
  assert.equal(lstatSync(path.join(dir, 'x')).isDirectory(), true, '`x` is now a directory');
  assert.equal(readFileSync(path.join(dir, 'x', 'y'), 'utf8'), 'ynew\n');
});

test('execute refuses a call whose approved set is null, not just absent (L)', async () => {
  // `approvedPaths: null` is "no approved set" the same as a missing field; spreading it would be a
  // raw TypeError rather than the declaration refusal the gate records.
  resetRepo();
  const before = snapshot(repo);
  await assert.rejects(
    () => tool.execute({ diff: UNIFIED_LOCK }, ctxIn({ approvedPaths: null as unknown as readonly string[] })),
    (err: unknown) => err instanceof ToolDeclarationError
      && /arrived without the paths the policy approved/.test(err.message),
  );
  assert.deepEqual(changedSince(before), [], 'a refused call writes nothing');
});

test('real git output, diff -u output and Helm YAML still apply (L2)', async () => {
  // The grammar is a refusal of lines git would skip, not of diff syntax it reads: the three
  // producers a user's workflow hands this tool must all go through.
  resetRepo();
  writeFileSync(path.join(repo, 'README'), 'r2\n', 'utf8');
  const ordinary = git(repo, ['diff', '--', 'README']);
  assert.equal(ordinary.status, 0);
  assert.match(ordinary.stdout, /^diff --git /m);
  resetRepo();
  const fromGit = await executeGated({ diff: ordinary.stdout });
  assert.equal(fromGit.exitCode, 0, fromGit.stderr);
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'r2\n');

  const oldFile = path.join(scratch, 'old.txt');
  const newFile = path.join(scratch, 'new.txt');
  writeFileSync(oldFile, 'one\ntwo\n', 'utf8');
  writeFileSync(newFile, 'one\nTWO\n', 'utf8');
  const unified = spawnSync('diff', ['-u', '-L', 'a/README', '-L', 'b/README', oldFile, newFile], { encoding: 'utf8' });
  assert.equal(unified.status, 1, 'diff exits 1 when the files differ');
  resetRepo();
  writeFileSync(path.join(repo, 'README'), 'one\ntwo\n', 'utf8');   // the old side the diff names
  const fromDiff = await executeGated({ diff: unified.stdout });
  assert.equal(fromDiff.exitCode, 0, fromDiff.stderr);
  assert.equal(readFileSync(path.join(repo, 'README'), 'utf8'), 'one\nTWO\n');

  // `helm template` emits `--- # Source: chart/a.yaml` as a document separator; in a diff it is a
  // context line, so it arrives as one space followed by a `--- ` that is content.
  resetRepo();
  const oldYaml = path.join(scratch, 'a.yaml');
  const newYaml = path.join(scratch, 'b.yaml');
  writeFileSync(oldYaml, '--- # Source: chart/a.yaml\nkind: A\nx: 1\n', 'utf8');
  writeFileSync(newYaml, '--- # Source: chart/a.yaml\nkind: A\nx: 2\n', 'utf8');
  const helm = spawnSync('diff', ['-u', '-L', 'a/k.yaml', '-L', 'b/k.yaml', oldYaml, newYaml], { encoding: 'utf8' });
  assert.equal(helm.status, 1);
  assert.match(helm.stdout, /\n --- # Source: chart\/a\.yaml/);
  writeFileSync(path.join(repo, 'k.yaml'), '--- # Source: chart/a.yaml\nkind: A\nx: 1\n', 'utf8');   // the old side
  const fromHelm = await executeGated({ diff: helm.stdout });
  assert.equal(fromHelm.exitCode, 0, fromHelm.stderr);
  assert.equal(readFileSync(path.join(repo, 'k.yaml'), 'utf8'), '--- # Source: chart/a.yaml\nkind: A\nx: 2\n');
});
