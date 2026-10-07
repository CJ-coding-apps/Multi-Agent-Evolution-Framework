#!/usr/bin/env node
// The doc-reference guard.
//
// A comment that cites a file the repository does not ship is worse than no comment: it
// reads as provenance, so a reader who trusts it believes the design came from a document
// they cannot open. This repo carried 39 such references — to three internal documents
// that are deliberately not published here — and every one of them named a real file on
// somebody's laptop. Nothing failed; they were found by reading.
//
// The rule this holds: a `.md` path named in a source comment, or a relative `.md` link in
// a document, must resolve to a file this repository ships. A name that is a *runtime*
// artifact rather than a document — a file the code creates, or one the user supplies in
// their own project — is not a citation and must be listed in RUNTIME_ARTIFACTS below, with
// its reason. The list is a review surface: adding to it is a decision, not an accident.
//
// Scope, and the three things that are deliberately not scanned:
//   * strings in code — a path a test writes is not a claim about this repository;
//   * fenced code blocks in documents — sample content for the reader's own project;
//   * absolute URLs — someone else's repository, which may not be fetchable from CI.
// A path resolves against the containing file's directory first, then the repository root,
// so a `docs/` cross-link and a root-relative one both work.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['packages', 'tests', 'scripts', 'docs', '.github'];
const SCAN_ROOT_FILES = ['README.md', 'CHANGELOG.md', 'NOTICE', 'CONTRIBUTING.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.maf', 'coverage']);
const CODE_EXTS = new Set(['.ts', '.mjs', '.js']);
// `.json` is here for the golden corpus, whose `provenance.ref` fields cited internal
// documents by name in exactly the same way the comments did.
const PROSE_EXTS = new Set(['.md', '.yml', '.yaml', '.json']);

/**
 * Names that are runtime artifacts, not documents this repository ships. Keyed by the
 * exact token as it appears in the source, because that is what a reader sees.
 */
const RUNTIME_ARTIFACTS = new Map([
  ['WORKFLOW.md', 'the DAG spec in the *target* project (DagParser reads it); not a doc in this repo'],
]);

const MD_TOKEN = /(?<![\w./-])[\w][\w./-]*\.md\b/g;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The comments in a JS/TS source, as one string. Tracks quotes so a `//` inside a string
 * does not open a comment. A `//` inside a *regex literal* would be misread as one; no
 * regex in this repo contains `.md`, so the tolerant scanner is enough here.
 */
function commentsOf(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      out += source.slice(i, end === -1 ? n : end) + '\n';
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      out += source.slice(i, end === -1 ? n : end + 2) + '\n';
      i = end === -1 ? n : end + 2;
      continue;
    }
    i += 1;
  }
  return out;
}

function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/g, ' ');
}

function stripFences(text) {
  return text.replace(/^[ \t]*```.*?^[ \t]*```/gms, ' ');
}

/** Resolve a cited path the way a reader would: beside the file, then from the root. */
async function resolves(file, token) {
  const cleaned = token.replace(/^\.\//, '');
  if (await exists(path.join(path.dirname(file), cleaned))) return true;
  return exists(path.join(ROOT, cleaned));
}

const files = [];
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (await exists(abs)) await walk(abs, files);
}
for (const name of SCAN_ROOT_FILES) {
  const abs = path.join(ROOT, name);
  if (await exists(abs)) files.push(abs);
}

const problems = [];
const allowed = [];
let checked = 0;

for (const file of files.sort()) {
  const ext = path.extname(file);
  const isCode = CODE_EXTS.has(ext);
  const isProse = PROSE_EXTS.has(ext);
  if (!isCode && !isProse) continue;

  const raw = await readFile(file, 'utf8');
  const scanned = stripUrls(isCode ? commentsOf(raw) : stripFences(raw));
  const relative = path.relative(ROOT, file);
  const seen = new Set();

  for (const match of scanned.matchAll(MD_TOKEN)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    checked += 1;

    if (RUNTIME_ARTIFACTS.has(token)) {
      allowed.push(`${relative}: ${token} — ${RUNTIME_ARTIFACTS.get(token)}`);
      continue;
    }
    if (await resolves(file, token)) continue;

    problems.push(`${relative}: cites "${token}", which this repository does not ship`);
  }
}

const stale = [...RUNTIME_ARTIFACTS.keys()].filter(
  (name) => !allowed.some((line) => line.includes(`: ${name} —`)),
);

for (const problem of problems) console.error(`FAIL  ${problem}`);
for (const name of stale) {
  console.error(`FAIL  RUNTIME_ARTIFACTS lists "${name}", which no source cites any more — delete the entry`);
}

console.log(
  `doc-reference guard: ${checked} .md reference(s) across ${SCAN_DIRS.length} dirs + ${SCAN_ROOT_FILES.length} root files, all resolving`,
);
if (allowed.length > 0) {
  console.log(`runtime artifacts (not documents), ${allowed.length} site(s):`);
  for (const line of allowed) console.log(`  · ${line}`);
}

if (problems.length > 0 || stale.length > 0) {
  console.error(`\n${problems.length + stale.length} dangling doc reference(s). Inline the reason, or ship the file.`);
  process.exit(1);
}
console.log('OK');
