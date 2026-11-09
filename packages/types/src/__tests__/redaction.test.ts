import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactEvidenceText } from '../index.js';

// ORACLE (WP-3.7a R2-L3): a policy refusal's `reason` is written into the memory graph and read
// into the evolver planner's prompt, which a real model sees in WP-3.7b. The machine's layout is
// not the planner's business, but the FILE is: a path inside the repository keeps its relative
// tail. These pin the shapes that used to escape — Windows drive paths, UNC shares, quoted paths
// with spaces, and a path that follows a colon.

test('a quoted POSIX path with spaces is one path, not a head and a leaked tail', () => {
  const out = redactEvidenceText('Path "/Users/John Smith/proj/.env" is outside the project root');
  assert.equal(out, 'Path [REDACTED:path] is outside the project root');
  assert.doesNotMatch(out, /John Smith/, 'no part of the path survives');
});

test('a Windows drive path is masked, quoted or not', () => {
  assert.equal(redactEvidenceText('Path "C:/Users/John Smith/proj/.env" is outside'),
    'Path [REDACTED:path] is outside');
  assert.equal(redactEvidenceText('root C:\\Users\\me\\repo\\.env refused'),
    'root [REDACTED:path] refused');
});

test('a UNC share is a path', () => {
  const out = redactEvidenceText('refused \\\\fileserver\\share\\secrets\\creds.txt');
  assert.equal(out, 'refused [REDACTED:path]');
  assert.doesNotMatch(out, /fileserver/);
});

test('a path that follows a colon is still a path', () => {
  assert.equal(redactEvidenceText('resolved to:/sessions/me/repo/x.txt'),
    'resolved to:[REDACTED:path]');
});

test('a URL is not read as a POSIX path', () => {
  assert.equal(redactEvidenceText('see https://example.com/docs/a for details'),
    'see https://example.com/docs/a for details');
});

test('an in-repo path keeps its repo-relative tail so the planner can name the file', () => {
  const out = redactEvidenceText(
    'Path "/repo/src/a.ts" is outside the project root "/repo"', ['/repo'],
  );
  assert.equal(out, 'Path "src/a.ts" is outside the project root "."');
  assert.doesNotMatch(out, /\/repo/, 'the machine layout goes');
});

test('relativization respects the separator boundary', () => {
  // `/repo-other` is not under `/repo`; it must be masked, not half-rewritten.
  const out = redactEvidenceText('refused /repo-other/src/a.ts', ['/repo']);
  assert.equal(out, 'refused [REDACTED:path]');
});

test('a credential inside a path is masked and leaves no path fragment behind', () => {
  const out = redactEvidenceText('wrote /home/me/ghp_Zq9Xr2LmN4pQ7sT1vW3yA5bC8dE0fG/notes.txt');
  assert.doesNotMatch(out, /ghp_/);
  assert.doesNotMatch(out, /notes\.txt/, 'the whole path went, not just the secret segment');
});

// R3-L2: an unquoted path with a space used to be matched only to the first space, so the tail
// after it survived the mask — a leak in free-text reasons, where nothing bounds the path but the
// path itself. The whole path goes; a token that still carries a separator is part of it.
test('an unquoted POSIX path with a space is one path, not a head and a leaked tail', () => {
  const out = redactEvidenceText('Path /Users/a b/secret.txt refused');
  assert.equal(out, 'Path [REDACTED:path] refused');
  assert.doesNotMatch(out, /b\/secret\.txt/, 'nothing after the space survives');
});

test('an unquoted Windows path with a space is masked whole', () => {
  const out = redactEvidenceText('Path C:\\Program Files\\x\\key.pem refused');
  assert.equal(out, 'Path [REDACTED:path] refused');
  assert.doesNotMatch(out, /Files|x\\key\.pem/, 'nothing after the space survives');
});

test('an unquoted spaced path inside the repo still keeps its repo-relative tail', () => {
  const out = redactEvidenceText('refused /Users/a b/proj/secret.txt', ['/Users/a b/proj']);
  assert.equal(out, 'refused secret.txt');
  assert.doesNotMatch(out, /\/Users/);
});
