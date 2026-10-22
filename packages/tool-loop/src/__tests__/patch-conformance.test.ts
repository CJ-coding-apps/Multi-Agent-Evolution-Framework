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
  AttestorHandle, PolicyDecision, ToolCallRecord, ToolContext, ToolResult,
} from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, ToolDeclarationError } from '@maf/types';
import { PolicyLoader, PolicyViolationError } from '@maf/policy-engine';
import type { PolicyEngine } from '@maf/policy-engine';
import { PatchApplyTool } from '@maf/tools';
import { executeToolGated } from '../index.js';

// ORACLE: 0.5.1 — the conformance table of the round-3 review's verdict (Verify2b), row for row.
// That verdict is an internal review, not a file this repository ships; the table is reproduced
// here, so a reader needs nothing but this file.
//
// The verdict measured the old header parser against GNU patch and found 17 mismatches: five
// independent ways a file a shipped rule protects (`.env`, `*.lock`, `.maf/policy.yaml`, the tester
// allow-list) could be written under an `Allow`. The fix is not a better header parser — it is to
// stop parsing headers. `patch.apply` asks `git apply` which files the diff names, forward and
// reversed (the same file, the same `-p`, the same sealed context), refuses what git reports in
// forms a path list cannot describe (`--summary`: renames, copies, mode changes, submodules), and
// refuses a section whose two directions name different files — that is a rename git was never
// told about, and one direction alone shows only its destination. It then applies the same bytes in
// that same context. The declaration and the write are the same program reading the same file.
//
// Every row below is asserted against the policy file the repository ships, loaded the way a run
// loads it, and the table drives `executeToolGated`, the real gate. Two properties hold for every
// row, and they are the whole conformance claim:
//
//   1. either the call is refused before policy or with it, and nothing is written; or
//   2. the set of files the apply writes is exactly the set the policy was shown.
//
// Where git's answer differs from GNU patch's, the difference is stated in the row: `git apply`
// cannot read context diffs, `Index:`-only diffs, normal or ed diffs, and silently skips an indented
// section, so the tool refuses those before git is asked — fail-closed, which is what the verdict
// asked for.

// dist/__tests__ → package → packages → repository root.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SHIPPED_POLICY = path.join(REPO_ROOT, '.maf', 'policy.yaml');
const STAMP = '\t2026-01-01 00:00:00.000000000 +0000';

const SEED: Record<string, string> = {
  'README':           'r\n',
  'Cargo.lock':       'lock1\n',
  '.env':             'SAFE=1\n',
  'src/app.js':       'x\n',
  'my file.lock':     'm\n',
  '.maf/policy.yaml': 'policy\n',
  'notes':            'n\n',
  'Cargo.lock2':      'l2\n',
  'nothere':          'lock1\n',
  'n.txt':            '-- a/Cargo.lock\n',
  'copy.txt':         'c\n',
  'q"x.lock':         'q\n',
};

let projectRoot = '';
let engine: PolicyEngine;
const tool = new PatchApplyTool();

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

before(async () => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'maf-051-conformance-'));
  for (const [name, body] of Object.entries(SEED)) {
    mkdirSync(path.dirname(path.join(projectRoot, name)), { recursive: true });
    writeFileSync(path.join(projectRoot, name), body, 'utf8');
  }
  assert.equal(git(projectRoot, ['init', '-q', '.']).status, 0);
  assert.equal(git(projectRoot, ['add', '-A']).status, 0);
  assert.equal(git(projectRoot, [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'seed',
  ]).status, 0);
  // `caseInsensitivePaths: true` explicitly, so the macOS rows (`.ENV` is `.env` here) are decided
  // the same way on a case-sensitive CI filesystem. Absent, the engine asks the platform.
  engine = await PolicyLoader.loadEngine(SHIPPED_POLICY, {} as never, { caseInsensitivePaths: true });
});

after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function resetRepo(): void {
  assert.equal(git(projectRoot, ['reset', '--hard', '-q']).status, 0);
  assert.equal(git(projectRoot, ['clean', '-fdq']).status, 0);
}

/** `/`-joined, NFC, case-folded where the filesystem is: one key for the declared name and the written one. */
function pathKey(p: string): string {
  const normal = p.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32' ? normal.toLowerCase() : normal;
}

interface TreeEntry { sha: string; mode: number }

function snapshot(): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (rel: string): void => {
    const abs = rel === '' ? projectRoot : path.join(projectRoot, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && entry.name === '.git') continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(projectRoot, child);
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

function changedSince(before: Map<string, TreeEntry>): string[] {
  const after = snapshot();
  const changed: string[] = [];
  for (const [key, entry] of after) {
    const was = before.get(key);
    if (was === undefined || was.sha !== entry.sha || was.mode !== entry.mode) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) changed.push(key);
  return changed.sort();
}

function ctxIn(agentRole = 'coder'): ToolContext {
  return {
    cwd: projectRoot, projectRoot,
    runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
    sessionId: 's1', agentRole,
    policy: engine, attestor: {} as AttestorHandle,
  };
}

// ─── the table ──────────────────────────────────────────────────────────────

type Expectation =
  | { declared: 'REFUSED' }
  | { declared: string[]; verdict: 'Allow' }
  | { declared: string[]; verdict: 'Deny' | 'Escalate'; ruleId: string };

interface Row {
  n: number;
  name: string;
  diff: string;
  strip?: number;
  role?: string;
  expect: Expectation;
  /** Where git's answer differs from GNU patch's, and why the difference is the safe one. */
  note?: string;
}

const unified = (a: string, b: string, body = '@@ -1 +1 @@\n-lock1\n+lock2\n'): string =>
  `--- ${a}\n+++ ${b}\n${body}`;
const readmeSection = (): string => '--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n+s\n';
const envHunk = '@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n';

const ROWS: Row[] = [
  { n: 1,  name: 'unified, no timestamp', diff: unified('a/Cargo.lock', 'b/Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 2,  name: 'unified, TAB timestamp (diff -u)', diff: unified(`a/Cargo.lock${STAMP}`, `b/Cargo.lock${STAMP}`),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 3,  name: 'unified, space timestamp', diff: unified('a/Cargo.lock 2026-01-01 00:00:00', 'b/Cargo.lock 2026-01-01 00:00:00'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' },
    note: 'git ends the name at the whitespace, as GNU patch does, so the timestamp is not part of it.' },
  { n: 4,  name: 'unified, space trailer', diff: unified('a/Cargo.lock x', 'b/Cargo.lock x'),
    expect: { declared: ['Cargo.lock x'], verdict: 'Allow' },
    note: 'git keeps a trailing word that is not a timestamp in the name, and there is no such file, '
      + 'so the check fails and nothing is written. `.env /x` (row 5) is the same shape.' },
  { n: 5,  name: 'unified, +++ b/.env /x', diff: unified('a/.env /x', 'b/.env /x', envHunk),
    expect: { declared: ['.env /x'], verdict: 'Allow' },
    note: 'the declared name is `.env /x`, not `.env`: the policy is shown the name git would write.' },
  { n: 6,  name: 'context diff, space timestamp', diff: '*** a/Cargo.lock 2026-01-01\n--- b/Cargo.lock 2026-01-01\n***************\n*** 1 ****\n- lock1\n--- 1 ----\n+ lock2\n',
    expect: { declared: 'REFUSED' },
    note: 'git applies unified diffs only; a context diff names no file it would write, so it is refused.' },
  { n: 7,  name: 'tester role, +++ b/src/app.js x_test', diff: unified('a/src/app.js x_test', 'b/src/app.js x_test', '@@ -1 +1 @@\n-x\n+y\n'),
    role: 'tester', expect: { declared: ['src/app.js x_test'], verdict: 'Allow' },
    note: 'the tester allow-list sees the name git reports, and `src/app.js` itself is never the target.' },
  { n: 8,  name: 'name with space + TAB timestamp', diff: unified(`a/my file.lock${STAMP}`, `b/my file.lock${STAMP}`, '@@ -1 +1 @@\n-m\n+n\n'),
    expect: { declared: ['my file.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 9,  name: 'Index:-only, -p1', strip: 1, diff: 'Index: Cargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n',
    expect: { declared: 'REFUSED' }, note: 'git does not read `Index:`; no header, no declaration.' },
  { n: 10, name: 'Index: Cargo.lock only, -p0', strip: 0, diff: 'Index: Cargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 11, name: 'Index: .env only, -p0', strip: 0, diff: 'Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    expect: { declared: 'REFUSED' } },
  { n: 12, name: 'Index: .env only, -p1', strip: 1, diff: 'Index: .env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    expect: { declared: 'REFUSED' } },
  { n: 13, name: 'Index:.env (no space), alone, -p0', strip: 0, diff: 'Index:.env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    expect: { declared: 'REFUSED' } },
  { n: 14, name: 'Index:.env after a README section, -p0', strip: 0, diff: readmeSection() + 'Index:.env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    expect: { declared: 'REFUSED' },
    note: 'the reported bypass: GNU patch applied both sections. git refuses the whole diff under '
      + '`--recount` (`unexpected line: Index`), so neither file can be written.' },
  { n: 15, name: 'Index:<TAB>.env after a README section, -p0', strip: 0, diff: readmeSection() + 'Index:\t.env\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n',
    expect: { declared: 'REFUSED' } },
  { n: 16, name: 'Index: my file.lock (space in name), -p0', strip: 0, diff: 'Index: my file.lock\n@@ -1 +1 @@\n-m\n+n\n',
    expect: { declared: 'REFUSED' } },
  { n: 17, name: 'Index: + === + unified on README, -p0', strip: 0, diff: 'Index: Cargo.lock\n===\n--- README\n+++ README\n@@ -1 +1 @@\n-r\n+s\n',
    expect: { declared: ['README'], verdict: 'Allow' },
    note: 'git follows the `---`/`+++` pair; the `Index:` line names no file git writes.' },
  { n: 18, name: 'context diff, TAB timestamps', diff: `*** a/Cargo.lock${STAMP}\n--- b/Cargo.lock${STAMP}\n***************\n*** 1 ****\n- lock1\n--- 1 ----\n+ lock2\n`,
    expect: { declared: 'REFUSED' } },
  { n: 19, name: 'diff --git a/ b/', diff: `diff --git a/Cargo.lock b/Cargo.lock\n${unified('a/Cargo.lock', 'b/Cargo.lock')}`,
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 20, name: 'diff --git no prefix, -p0', strip: 0, diff: 'diff --git Cargo.lock Cargo.lock\n' + unified('Cargo.lock', 'Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 21, name: 'diff --git no prefix, src/Cargo.lock at -p1', strip: 1, diff: 'diff --git src/Cargo.lock src/Cargo.lock\n' + unified('src/Cargo.lock', 'src/Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 22, name: 'diff --git quoted, space in name', diff: 'diff --git "a/my file.lock" "b/my file.lock"\n' + unified('"a/my file.lock"', '"b/my file.lock"', '@@ -1 +1 @@\n-m\n+n\n'),
    expect: { declared: ['my file.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 23, name: 'quoted octal escape "b/\\056env"', diff: 'diff --git a/.env b/.env\n' + unified('"a/\\056env"', '"b/\\056env"', envHunk),
    expect: { declared: ['.env'], verdict: 'Deny', ruleId: 'deny-env-files' },
    note: 'git decodes the octal before naming the file, so the rule sees `.env`.' },
  { n: 24, name: 'unified quoted octal "b/Cargo\\056lock"', diff: unified('"a/Cargo\\056lock"', '"b/Cargo\\056lock"'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 25, name: 'unified quoted escaped quote "b/q\\"x.lock"', diff: unified('"a/q\\"x.lock"', '"b/q\\"x.lock"', '@@ -1 +1 @@\n-q\n+r\n'),
    expect: { declared: ['q"x.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 26, name: 'git rename, quoted octal target', diff: 'diff --git a/notes "b/Cargo\\056lock2"\nsimilarity index 100%\nrename from notes\nrename to "Cargo\\056lock2"\n',
    expect: { declared: 'REFUSED' }, note: '`--numstat` names only the new side of a rename; refused from `--summary`.' },
  { n: 27, name: 'git pure rename', diff: 'diff --git a/README b/Cargo.lock2\nsimilarity index 100%\nrename from README\nrename to Cargo.lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 28, name: 'rename where rename to != diff --git b-name', diff: 'diff --git a/README b/x.txt\nsimilarity index 100%\nrename from README\nrename to Cargo.lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 29, name: 'git copy', diff: 'diff --git a/copy.txt b/copy2.txt\nsimilarity index 100%\ncopy from copy.txt\ncopy to copy2.txt\n',
    expect: { declared: 'REFUSED' } },
  { n: 30, name: 'git mode-only change', diff: 'diff --git a/Cargo.lock b/Cargo.lock\nold mode 100644\nnew mode 100755\n',
    expect: { declared: 'REFUSED' } },
  { n: 31, name: '--- /dev/null creation', diff: '--- /dev/null\n+++ b/new.lock\n@@ -0,0 +1 @@\n+new\n',
    expect: { declared: ['new.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 32, name: 'multi-file unified, no diff --git separators', diff: readmeSection() + unified('a/Cargo.lock', 'b/Cargo.lock'),
    expect: { declared: ['README', 'Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' },
    note: 'git reads the concatenated `diff -u` sections one after the other and names both files. '
      + '(`--recount` made git read them as one section, which is why it was dropped.)' },
  { n: 33, name: 'CRLF line endings', diff: '--- a/Cargo.lock\r\n+++ b/Cargo.lock\r\n@@ -1 +1 @@\r\n-lock1\r\n+lock2\r\n',
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' },
    note: 'git keeps the CR in the hunk body and the apply fails; the policy refuses the call first either way.' },
  { n: 34, name: 'whole diff indented 2 spaces', diff: readmeSection().split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n'),
    expect: { declared: 'REFUSED' },
    note: 'git would skip the whole section and exit 0; the indented header is refused instead.' },
  { n: 35, name: 'README then a space-indented .env section', diff: readmeSection() + '  --- a/.env\n  +++ b/.env\n  @@ -1 +1 @@\n  -SAFE=1\n  +LEAK=1\n',
    expect: { declared: 'REFUSED' },
    note: 'git ignores the indented section and reports success for the rest; refused, because the '
      + 'agent would be told the whole diff applied when only part of it did.' },
  { n: 36, name: 'README then a TAB-indented Cargo.lock section', diff: readmeSection() + '\t--- a/Cargo.lock\n\t+++ b/Cargo.lock\n\t@@ -1 +1 @@\n\t-lock1\n\t+lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 37, name: 'README then an X-prefixed Cargo.lock section', diff: readmeSection() + 'X--- a/Cargo.lock\nX+++ b/Cargo.lock\nX@@ -1 +1 @@\nX-lock1\nX+lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 38, name: 'normal diff, no names', diff: '1c1\n< r\n---\n> s\n',
    expect: { declared: 'REFUSED' }, note: 'the tool promises a unified diff; git applies nothing else.' },
  { n: 39, name: 'normal diff with Index:, -p0', strip: 0, diff: 'Index: Cargo.lock\n1c1\n< lock1\n---\n> lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 40, name: 'ed-style with Index:, -p0', strip: 0, diff: 'Index: Cargo.lock\n1c\nlock1\n.\n',
    expect: { declared: 'REFUSED' } },
  { n: 41, name: '--- / +++ differ, old file exists', diff: unified('a/README', 'b/Cargo.lock.new', '@@ -1 +1 @@\n-r\n+s\n'),
    expect: { declared: ['Cargo.lock.new'], verdict: 'Allow' },
    note: 'git names the new side. No such file exists, so the check fails and nothing is written.' },
  { n: 42, name: '--- / +++ differ, new file exists', diff: unified('a/nothere', 'b/Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 43, name: 'a//Cargo.lock at -p1', diff: unified('a//Cargo.lock', 'a//Cargo.lock'),
    expect: { declared: 'REFUSED' }, note: 'git leaves `/Cargo.lock`; an absolute name is refused.' },
  { n: 44, name: 'a//b/.maf/policy.yaml at -p2', strip: 2, diff: unified('a//b/.maf/policy.yaml', 'a//b/.maf/policy.yaml', '@@ -1 +1 @@\n-policy\n+tampered\n'),
    expect: { declared: ['b/.maf/policy.yaml'], verdict: 'Allow' },
    note: 'git counts the empty component, so -p2 leaves `b/.maf/policy.yaml` — a different file from '
      + 'maf\'s, which is why `deny-maf-dir` (root-anchored) does not fire. No such file exists here, '
      + 'so nothing is written; and `.maf/policy.yaml` is never the target.' },
  { n: 45, name: './a/Cargo.lock at -p2', strip: 2, diff: unified('./a/Cargo.lock', './a/Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' } },
  { n: 46, name: 'a/../out.lock', diff: unified('a/../out.lock', 'a/../out.lock'),
    expect: { declared: 'REFUSED' }, note: 'git would write `../out.lock`; refused for `..`.' },
  { n: 47, name: 'absolute /tmp/zz-abs.lock at -p0', strip: 0, diff: unified('/tmp/zz-abs.lock', '/tmp/zz-abs.lock'),
    expect: { declared: 'REFUSED' } },
  { n: 48, name: 'Prereq: line', diff: 'Prereq: 1.0\n' + unified('a/Cargo.lock', 'b/Cargo.lock'),
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' },
    note: 'git ignores the non-header line and names the file the unified section touches.' },
  { n: 49, name: '---<TAB> / +++<TAB> (no space after the marker)', diff: '---\tCargo.lock\n+++\tCargo.lock\n@@ -1 +1 @@\n-lock1\n+lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 50, name: 'hunk body line beginning `--- `', diff: '--- a/n.txt\n+++ b/n.txt\n@@ -1 +1 @@\n--- a/Cargo.lock\n+replaced\n',
    expect: { declared: ['n.txt'], verdict: 'Allow' },
    note: 'the removed line\'s content is `-- a/Cargo.lock`; git reads it as a hunk line, never as a header.' },

  // Round 2 (HP1, HP6b): the forms where a path list read forwards alone names only half the
  // change. `--summary` reports nothing for any of them, so both directions of `--numstat` are what
  // makes them visible.
  { n: 51, name: 'implicit rename of .env to notes.txt', diff: 'diff --git a/.env b/notes.txt\n--- a/.env\n+++ b/notes.txt\n' + envHunk,
    expect: { declared: 'REFUSED' },
    note: 'git reports `notes.txt` forward and `.env` reversed. The forward list alone says Allow, '
      + 'and the apply deletes `.env`.' },
  { n: 52, name: 'implicit rename of Cargo.lock to away.txt', diff: 'diff --git a/Cargo.lock b/away.txt\n--- a/Cargo.lock\n+++ b/away.txt\n@@ -1 +1 @@\n-lock1\n+lock2\n',
    expect: { declared: 'REFUSED' } },
  { n: 53, name: 'implicit rename of .maf/policy.yaml to policy-copy.txt', diff: 'diff --git a/.maf/policy.yaml b/policy-copy.txt\n--- a/.maf/policy.yaml\n+++ b/policy-copy.txt\n@@ -1 +1 @@\n-policy\n+tampered\n',
    expect: { declared: 'REFUSED' } },
  { n: 54, name: 'deletion of Cargo.lock', diff: 'diff --git a/Cargo.lock b/Cargo.lock\ndeleted file mode 100644\n--- a/Cargo.lock\n+++ /dev/null\n@@ -1 +0,0 @@\n-lock1\n',
    expect: { declared: ['Cargo.lock'], verdict: 'Escalate', ruleId: 'protect-lock-files' },
    note: 'a deletion names the same file both ways — only the counts swap — so it is a plain write '
      + 'to that path, and the lock rule refuses it.' },
  { n: 55, name: 'diff --git header applied at -p0', strip: 0, diff: 'diff --git a/README b/README\n--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n+s\n',
    expect: { declared: 'REFUSED' },
    note: 'at -p0 the prefix is not stripped, so git names `a/README` and `b/README` — two different '
      + 'files — and the section is a rename it was not told about.' },
];

// ─── the runner every row and every regression test uses ────────────────────

interface Outcome {
  row: Row;
  declared: string[] | Error;
  decision: PolicyDecision;
  changed: string[];
  result: ToolResult | undefined;
}

function ruleIdOf(decision: PolicyDecision): string | undefined {
  switch (decision.verdict) {
    case 'Deny':          return decision.ruleId;
    case 'Escalate':      return decision.approvalRequest.policyRuleId;
    case 'Indeterminate': return decision.ruleId;
    default:              return undefined;
  }
}

async function exercise(row: Row): Promise<Outcome> {
  resetRepo();
  const before = snapshot();
  const input = row.strip === undefined ? { diff: row.diff } : { diff: row.diff, strip: row.strip };

  let declared: string[] | Error;
  // The same context the gate gives it: the declaration is computed where the apply will run, so a
  // path that is a symlink now is refused here as a verdict (R2-L2/HS23), not allowed and then failed.
  try { declared = tool.declaredPaths(input, ctxIn(row.role)); } catch (err: unknown) { declared = err as Error; }

  const attestor = new SpyAttestor();
  let decision: PolicyDecision | undefined;
  let result: ToolResult | undefined;
  try {
    result = await executeToolGated(tool, input, ctxIn(row.role), { policy: engine, attestor });
    decision = attestor.records[0]?.policyDecision;
  } catch (err: unknown) {
    assert.ok(err instanceof PolicyViolationError, `${row.n}: only a policy refusal may be thrown: ${String(err)}`);
    decision = attestor.records[0]?.policyDecision;
  }
  assert.ok(decision !== undefined, `${row.n}: the call is attested`);
  return { row, declared, decision, changed: changedSince(before), result };
}

/** The declaration, the verdict, and the invariant — the three claims each row makes. */
function assertRow(o: Outcome): void {
  const { row, declared, decision, changed } = o;
  const where = `row ${row.n} (${row.name})`;

  if (row.expect.declared === 'REFUSED') {
    assert.ok(declared instanceof Error, `${where}: expected a declaration refusal, got ${JSON.stringify(declared)}`);
    assert.ok(declared instanceof ToolDeclarationError, `${where}: a ToolDeclarationError, not ${declared.constructor.name}`);
    assert.equal(decision.verdict, 'Deny', where);
    assert.equal(ruleIdOf(decision), 'builtin:declaration', where);
    assert.deepEqual(changed, [], `${where}: a refused diff writes nothing`);
    return;
  }

  assert.ok(Array.isArray(declared), `${where}: refused (${String(declared)})`);
  assert.deepEqual([...declared].sort(), [...row.expect.declared].sort(), `${where}: the declared set`);
  assert.equal(decision.verdict, row.expect.verdict, where);
  if (row.expect.verdict !== 'Allow') {
    assert.equal(ruleIdOf(decision), row.expect.ruleId, where);
    assert.deepEqual(changed, [], `${where}: a refused call writes nothing`);
    return;
  }

  // Allowed: whatever ran wrote only what the policy was shown, and a successful apply wrote it all.
  const declaredKeys = new Set(row.expect.declared.map(pathKey));
  for (const key of changed) {
    assert.ok(declaredKeys.has(key), `${where}: wrote ${JSON.stringify(key)} without declaring it`);
  }
  if (o.result?.exitCode === 0) {
    assert.deepEqual(changed, row.expect.declared.map(pathKey).sort(), `${where}: a successful apply wrote exactly the declared set`);
  }
}

async function runRow(n: number): Promise<Outcome> {
  const row = ROWS.find((r) => r.n === n);
  assert.ok(row !== undefined, `no row ${n}`);
  const outcome = await exercise(row);
  assertRow(outcome);
  return outcome;
}

// ─── the table, one subtest per row ─────────────────────────────────────────

test('VERDICT-Verify2b conformance table: every row declares what git writes, or writes nothing', async (t) => {
  for (const row of ROWS) {
    await t.test(`${row.n}. ${row.name}`, async () => { assertRow(await exercise(row)); });
  }
});

// ─── the 24 regression cases, in the verdict's order ────────────────────────
//
// Where the case names a GNU-patch outcome the git design does not reproduce (context diffs are
// refused, indented sections are ignored, renames cannot be declared), the test asserts the
// fail-closed form and says so. A test that asserted the old parser's answer would be asserting
// the bypass.

test('R1 — a space timestamp does not become part of the name', async () => {
  const o = await runRow(3);
  assert.ok(Array.isArray(o.declared));
  assert.equal(o.declared[0], 'Cargo.lock');
});

test('R2 — `+++ b/.env /x` never names `.env`', async () => {
  const o = await runRow(5);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['.env /x']);
  assert.equal(o.decision.verdict, 'Allow', 'the rule is asked about the name git would write');
  assert.deepEqual(o.changed, [], 'and no such file exists, so nothing is written');
  // The protected file is byte-identical.
  assert.equal(readFileSync(path.join(projectRoot, '.env'), 'utf8'), 'SAFE=1\n');
});

test('R3 — a context diff is refused rather than declared from its `***`/`---` pair', async () => {
  const o = await runRow(6);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.equal(ruleIdOf(o.decision), 'builtin:declaration');
});

test('R4 — the tester allow-list is shown git\'s name, and src/app.js is untouched', async () => {
  const o = await runRow(7);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['src/app.js x_test']);
  assert.equal(readFileSync(path.join(projectRoot, 'src/app.js'), 'utf8'), 'x\n');
});

test('R5 — a name with a space and a TAB timestamp keeps its space', async () => {
  const o = await runRow(8);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['my file.lock']);
  assert.equal(ruleIdOf(o.decision), 'protect-lock-files');
});

test('R6 — an octal-escaped .env is decoded before the rule sees it', async () => {
  const o = await runRow(23);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['.env']);
  assert.equal(ruleIdOf(o.decision), 'deny-env-files');
  assert.equal(readFileSync(path.join(projectRoot, '.env'), 'utf8'), 'SAFE=1\n');
});

test('R7 — an octal-escaped Cargo.lock is decoded before the rule sees it', async () => {
  const o = await runRow(24);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['Cargo.lock']);
  assert.equal(ruleIdOf(o.decision), 'protect-lock-files');
});

test('R8 — an escaped quote in a quoted name is decoded', async () => {
  const o = await runRow(25);
  assert.ok(Array.isArray(o.declared));
  assert.deepEqual(o.declared, ['q"x.lock']);
  assert.equal(ruleIdOf(o.decision), 'protect-lock-files');
});

test('R9 — a rename with an octal target is refused for being a rename', async () => {
  const o = await runRow(26);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /rename notes => Cargo\.lock2/);
});

test('R10 — a space-indented .env section after README is refused, and `.env` is untouched', async () => {
  const o = await runRow(35);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /indented section header/);
  assert.deepEqual(o.changed, []);
  assert.equal(readFileSync(path.join(projectRoot, '.env'), 'utf8'), 'SAFE=1\n');
});

test('R11 — TAB- and X-prefixed sections are refused: git would apply only the README half', async () => {
  for (const n of [36, 37]) {
    const o = await runRow(n);
    assert.ok(o.declared instanceof ToolDeclarationError, `row ${n}: ${JSON.stringify(o.declared)}`);
    assert.match(o.declared.message, /indented section header/, `row ${n}`);
    assert.deepEqual(o.changed, [], `row ${n}: nothing is written, README included`);
    assert.equal(readFileSync(path.join(projectRoot, 'README'), 'utf8'), 'r\n', `row ${n}`);
    assert.equal(readFileSync(path.join(projectRoot, 'Cargo.lock'), 'utf8'), 'lock1\n', `row ${n}`);
  }
});

test('R12 — a wholly indented diff is refused', async () => {
  const o = await runRow(34);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /indented section header/);
});

test('R13 — `Index:.env` and `Index:<TAB>.env` after a section are refused with the whole diff', async () => {
  for (const n of [14, 15]) await runRow(n);
  assert.equal(readFileSync(path.join(projectRoot, '.env'), 'utf8'), 'SAFE=1\n');
});

test('R14 — `a//b/.maf/policy.yaml` at -p2 names `b/.maf/policy.yaml`, never maf\'s policy', async () => {
  await runRow(44);
  assert.equal(readFileSync(path.join(projectRoot, '.maf/policy.yaml'), 'utf8'), 'policy\n');
});

test('R15 — `a//Cargo.lock` at -p1 is refused as an absolute name, not a policy Deny', async () => {
  const o = await runRow(43);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /absolute path/);
});

test('R16 — a CRLF diff names Cargo.lock and is refused by the lock rule', async () => {
  const o = await runRow(33);
  assert.deepEqual(o.changed, []);
});

test('R17 — headers naming different files declare the name git would write', async () => {
  const oldExists = await runRow(41);
  assert.ok(Array.isArray(oldExists.declared));
  assert.deepEqual(oldExists.declared, ['Cargo.lock.new']);
  assert.deepEqual(oldExists.changed, [], 'no such file: the check fails and nothing is written');
  const newExists = await runRow(42);
  assert.ok(Array.isArray(newExists.declared));
  assert.deepEqual(newExists.declared, ['Cargo.lock']);
  assert.equal(ruleIdOf(newExists.decision), 'protect-lock-files');
});

test('R18 — a rename whose `rename to` disagrees with the `diff --git` name is still a rename', async () => {
  const o = await runRow(28);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /rename README => Cargo\.lock2/);
});

test('R19 — a hunk body line beginning `--- ` declares no spurious path, at -p1 and -p0', async () => {
  await runRow(50);
  const atP0 = await exercise({
    n: 50, name: 'row 50 at -p0', strip: 0,
    diff: '--- n.txt\n+++ n.txt\n@@ -1 +1 @@\n--- a/Cargo.lock\n+replaced\n',
    expect: { declared: ['n.txt'], verdict: 'Allow' },
  });
  assertRow(atP0);
  assert.ok(Array.isArray(atP0.declared));
  assert.deepEqual(atP0.declared, ['n.txt']);
});

test('R20 — normal and ed-style diffs, with or without `Index:`, are refused', async () => {
  for (const n of [38, 39, 40]) await runRow(n);
});

test('R21 — a multi-file diff whose second file fails changes nothing', async () => {
  resetRepo();
  const before = snapshot();
  // Neither file is protected, so both are allowed and the second one's context is what fails.
  const diff = [
    'diff --git a/README b/README', '--- a/README', '+++ b/README', '@@ -1 +1 @@', '-r', '+s',
    'diff --git a/notes b/notes', '--- a/notes', '+++ b/notes', '@@ -1 +1 @@', '-nope', '+n', '',
  ].join('\n');
  const attestor = new SpyAttestor();
  const result = await executeToolGated(tool, { diff }, ctxIn(), { policy: engine, attestor });
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(changedSince(before), [], 'the check refused the whole diff, so README was not written either');
});

test('R22 — a failed apply leaves no .orig, no .rej and no temp file behind', async () => {
  resetRepo();
  const before = snapshot();
  // A private TMPDIR, so the assertion is about what this call made rather than about what else
  // on the machine happens to be in the system temp directory.
  const privateTmp = mkdtempSync(path.join(tmpdir(), 'maf-051-tmp-'));
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = privateTmp;
  try {
    const attestor = new SpyAttestor();
    const result = await executeToolGated(tool, {
      diff: '--- a/notes\n+++ b/notes\n@@ -1 +1 @@\n-nope\n+n\n',
    }, ctxIn(), { policy: engine, attestor });
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(changedSince(before), []);
    const leftovers = readdirSync(projectRoot, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.orig') || name.endsWith('.rej'));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(
      readdirSync(privateTmp),
      [],
      'the private temp directory, the diff file and the empty git directory are removed on every path',
    );
  } finally {
    if (saved === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = saved;
    rmSync(privateTmp, { recursive: true, force: true });
  }
});

test('R23 — an unusable temp directory fails the call before git runs and writes nothing', async () => {
  resetRepo();
  const before = snapshot();
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = path.join(projectRoot, 'no-such-dir', 'nested');
  try {
    // A failure to prepare the diff is not a verdict about the diff: it propagates, and the gate
    // does not turn it into permission.
    await assert.rejects(
      () => executeToolGated(tool, { diff: unified('a/Cargo.lock', 'b/Cargo.lock') }, ctxIn(), { policy: engine, attestor: new SpyAttestor() }),
      /ENOENT|no such file/i,
    );
  } finally {
    if (saved === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = saved;
  }
  assert.deepEqual(changedSince(before), []);
});

test('R24 — with no git to ask, the call is refused, and the recorded exit code is a number', async () => {
  resetRepo();
  const before = snapshot();
  const saved = process.env['PATH'];
  const empty = mkdtempSync(path.join(projectRoot, 'empty-path-'));
  process.env['PATH'] = empty;
  const attestor = new SpyAttestor();
  try {
    await assert.rejects(
      () => executeToolGated(tool, { diff: unified('a/Cargo.lock', 'b/Cargo.lock') }, ctxIn(), { policy: engine, attestor }),
      (err: unknown) => err instanceof PolicyViolationError,
    );
  } finally {
    if (saved === undefined) delete process.env['PATH']; else process.env['PATH'] = saved;
  }
  const record = attestor.records[0]!;
  assert.equal((record.policyDecision as { ruleId?: string }).ruleId, 'builtin:declaration');
  assert.equal(typeof record.result.exitCode, 'number', 'never a string errno (G-F3c)');
  assert.equal(record.result.metadata?.['refused'], true);
  assert.deepEqual(changedSince(before), []);
});

// ─── the four forms the fix must refuse or catch that the table states once ─

test('a rename cannot move a protected file out from under its rule', async () => {
  resetRepo();
  const before = snapshot();
  const diff = 'diff --git a/Cargo.lock b/away.lock\nsimilarity index 100%\nrename from Cargo.lock\nrename to away.lock\n';
  const attestor = new SpyAttestor();
  await assert.rejects(
    () => executeToolGated(tool, { diff }, ctxIn(), { policy: engine, attestor }),
    (err: unknown) => err instanceof PolicyViolationError,
  );
  assert.equal((attestor.records[0]!.policyDecision as { ruleId?: string }).ruleId, 'builtin:declaration');
  assert.deepEqual(changedSince(before), []);
});

test('a mode change is refused: the file list does not describe it', async () => {
  const o = await runRow(30);
  assert.ok(o.declared instanceof ToolDeclarationError);
  assert.match(o.declared.message, /mode change/);
});

test('creating a symlink is refused', async () => {
  resetRepo();
  const before = snapshot();
  const diff = 'diff --git a/link b/link\nnew file mode 120000\nindex 0000000..1234567\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n';
  const attestor = new SpyAttestor();
  await assert.rejects(
    () => executeToolGated(tool, { diff }, ctxIn(), { policy: engine, attestor }),
    (err: unknown) => err instanceof PolicyViolationError,
  );
  assert.equal((attestor.records[0]!.policyDecision as { ruleId?: string }).ruleId, 'builtin:declaration');
  assert.deepEqual(changedSince(before), []);
});

test('`.ENV` is declared as git names it and denied by `**/.env*` on a case-insensitive filesystem', async () => {
  resetRepo();
  const before = snapshot();
  const input = { diff: '--- a/.ENV\n+++ b/.ENV\n@@ -1 +1 @@\n-SAFE=1\n+LEAK=1\n' };
  assert.deepEqual(tool.declaredPaths(input), ['.ENV'], 'git keeps the spelling the diff uses');
  const attestor = new SpyAttestor();
  await assert.rejects(
    () => executeToolGated(tool, input, ctxIn(), { policy: engine, attestor }),
    (err: unknown) => err instanceof PolicyViolationError,
  );
  const decision = attestor.records[0]!.policyDecision as { verdict: string; ruleId?: string };
  assert.equal(decision.verdict, 'Deny');
  assert.equal(decision.ruleId, 'deny-env-files', 'the same file as `.env` on APFS and NTFS');
  assert.deepEqual(changedSince(before), []);
  assert.equal(readFileSync(path.join(projectRoot, '.env'), 'utf8'), 'SAFE=1\n');
});

// ─── round 2: what only a second git call, or a stat, can see ───────────────

test('HP1 — an implicit rename of a protected file is refused and moves nothing', async () => {
  const cases: ReadonlyArray<{ n: number; from: string; to: string; body: string }> = [
    { n: 51, from: '.env', to: 'notes.txt', body: envHunk },
    { n: 52, from: 'Cargo.lock', to: 'away.txt', body: '@@ -1 +1 @@\n-lock1\n+lock2\n' },
    { n: 53, from: '.maf/policy.yaml', to: 'policy-copy.txt', body: '@@ -1 +1 @@\n-policy\n+tampered\n' },
  ];
  for (const { n, from, to, body } of cases) {
    const o = await exercise({
      n, name: `implicit rename ${from} -> ${to}`,
      diff: `diff --git a/${from} b/${to}\n--- a/${from}\n+++ b/${to}\n${body}`,
      expect: { declared: 'REFUSED' },
    });
    assertRow(o);
    assert.ok(o.declared instanceof ToolDeclarationError);
    assert.match(o.declared.message, /on the old side and .* on the new/);
    assert.ok(o.declared.message.includes(JSON.stringify(from)), `${from}: the source is named`);
    assert.ok(o.declared.message.includes(JSON.stringify(to)), `${to}: the destination is named`);
    assert.deepEqual(o.changed, [], `${from}: neither side moves`);
    assert.equal(readFileSync(path.join(projectRoot, from), 'utf8'), SEED[from]!, `${from}: unchanged`);
    assert.equal(existsSync(path.join(projectRoot, to)), false, `${to}: never created`);
  }
});

test('HP4 — a plain diff on a symlink is refused: git rewrites the link in place', async () => {
  resetRepo();
  symlinkSync('README', path.join(projectRoot, 'link'));
  const before = snapshot();
  const diff = 'diff --git a/link b/link\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-r\n+SAFE=1\n';

  // git names the link both ways and `--summary` says nothing: the declaration is `link`, and the
  // write lands on whatever the link points at now — which the policy never saw.
  assert.deepEqual(tool.declaredPaths({ diff }), ['link']);

  const attestor = new SpyAttestor();
  await assert.rejects(
    () => executeToolGated(tool, { diff }, ctxIn(), { policy: engine, attestor }),
    (err: unknown) => err instanceof PolicyViolationError,
  );
  const decision = attestor.records[0]!.policyDecision as { verdict: string; ruleId?: string };
  assert.equal(decision.verdict, 'Deny');
  assert.equal(decision.ruleId, 'builtin:declaration');
  assert.deepEqual(changedSince(before), []);
  assert.equal(readlinkSync(path.join(projectRoot, 'link')), 'README');
  assert.equal(readFileSync(path.join(projectRoot, 'README'), 'utf8'), 'r\n');
});

test('HS1 — a temp directory inside the repository cannot change the name the declaration reports', async () => {
  resetRepo();
  const inside = mkdtempSync(path.join(projectRoot, 'scratch-'));
  const before = snapshot();
  // The declaration writes the diff to a private directory under TMPDIR and asks git from there.
  // When that directory was inside some repository and git was left to discover one, it prefixed
  // every name with the directory's path relative to the root — so the policy was asked about
  // `scratch-…/.maf/policy.yaml` while the apply wrote `.maf/policy.yaml`.
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = inside;
  try {
    const diff = '--- a/.maf/policy.yaml\n+++ b/.maf/policy.yaml\n@@ -1 +1 @@\n-policy\n+tampered\n';
    assert.deepEqual(
      tool.declaredPaths({ diff }),
      ['.maf/policy.yaml'],
      'the same name the apply would write, wherever the temp directory happens to be',
    );

    const attestor = new SpyAttestor();
    await assert.rejects(
      () => executeToolGated(tool, { diff }, ctxIn(), { policy: engine, attestor }),
      (err: unknown) => err instanceof PolicyViolationError,
    );
    const decision = attestor.records[0]!.policyDecision as { verdict: string; ruleId?: string };
    assert.equal(decision.verdict, 'Deny');
    assert.equal(decision.ruleId, 'deny-maf-dir', 'the shipped rule for maf\'s own directory');
    assert.deepEqual(changedSince(before), []);
    assert.equal(readFileSync(path.join(projectRoot, '.maf/policy.yaml'), 'utf8'), 'policy\n');
  } finally {
    if (saved === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = saved;
    rmSync(inside, { recursive: true, force: true });
  }
});

test('HP5 — a concatenated two-file `diff -u` is declared as both files and applies', async () => {
  const o = await exercise({
    n: 56, name: 'concatenated diff -u',
    diff: '--- a/README\n+++ b/README\n@@ -1 +1 @@\n-r\n+rr\n--- a/notes\n+++ b/notes\n@@ -1 +1 @@\n-n\n+nn\n',
    expect: { declared: ['README', 'notes'], verdict: 'Allow' },
  });
  assertRow(o);
  assert.equal(o.result?.exitCode, 0, `the apply succeeds: ${o.result?.stderr ?? ''}`);
  assert.deepEqual(o.changed, ['README', 'notes'].map(pathKey).sort());
});
