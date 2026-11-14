#!/usr/bin/env node
/**
 * R6-H1 (D-57): builds the encoded hidden store from a tree of plaintext hidden files.
 *
 * Hidden checks and reference solutions are not stored as plain files in the repository — the
 * verifier read `pool-lru`'s check with `test.run` and `/proc/<pid>/cwd`. They live in
 * `tests/goldens/hidden-store.json`, each gzip-compressed and base64-encoded, with a unique canary
 * comment at the top of the file so a read that reaches the record is detectable.
 *
 * Usage:
 *   node scripts/build-hidden-store.mjs --from-fixtures
 *       One-time migration: reads each fixture's `.checks/` and `.reference/` directories.
 *   node scripts/build-hidden-store.mjs build <sourceRoot>
 *       Builds from an extracted tree (`<sourceRoot>/<taskId>/.checks/...`).
 *   node scripts/build-hidden-store.mjs extract <destRoot>
 *       Writes the store's plaintext back out for editing. Extract, edit, build.
 *
 * The canonical store is mirrored byte-for-byte into `packages/cli/assets/goldens/`, which the
 * package's asset test requires. Run `pnpm -r build` first: the encoder is the package's own, so
 * the store this writes and the store a run reads cannot disagree about the format.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'tests', 'goldens');
const ASSETS = path.join(ROOT, 'packages', 'cli', 'assets', 'goldens');

const harness = await import(pathToFileURL(path.join(ROOT, 'packages', 'eval-harness', 'dist', 'index.js')).href);
const {
  HIDDEN_STORE_FILE, encodeHidden, injectCanary, loadHiddenStore, hiddenPaths, readHiddenFile,
  hiddenStorePath,
} = harness;

const SECTIONS = { '.checks': 'checks', '.reference': 'references' };

async function walkFiles(dir, rel = '') {
  const out = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel === '' ? entry.name : path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(dir, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

/** Insert `rel`'s encoded text into a store section, refusing a path outside a hidden section. */
function add(store, taskId, rel, text) {
  const section = SECTIONS[rel.split('/')[0]];
  if (section === undefined)
    throw new Error(`${path.posix.join(taskId, rel)} is not under .checks/ or .reference/`);
  if (text.includes(harness.CANARY_PREFIX))
    throw new Error(`${path.posix.join(taskId, rel)} already carries a canary; build from plaintext only`);
  store[section][taskId] ??= {};
  store[section][taskId][rel] = encodeHidden(injectCanary(text, taskId, rel));
}

function sorted(store) {
  const out = { version: 1, encoding: 'gzip+base64', checks: {}, references: {} };
  for (const section of ['checks', 'references']) {
    for (const taskId of Object.keys(store[section]).sort()) {
      out[section][taskId] = {};
      for (const rel of Object.keys(store[section][taskId]).sort())
        out[section][taskId][rel] = store[section][taskId][rel];
    }
  }
  return out;
}

async function write(store) {
  const text = `${JSON.stringify(sorted(store), null, 2)}\n`;
  await writeFile(hiddenStorePath(CORPUS), text, 'utf8');
  await mkdir(ASSETS, { recursive: true });
  await writeFile(path.join(ASSETS, HIDDEN_STORE_FILE), text, 'utf8');
  const checks = Object.values(store.checks).reduce((n, files) => n + Object.keys(files).length, 0);
  const references = Object.values(store.references).reduce((n, files) => n + Object.keys(files).length, 0);
  console.log(`[hidden-store] ${checks} check file(s) for ${Object.keys(store.checks).length} task(s), ` +
    `${references} reference file(s) for ${Object.keys(store.references).length} task(s) → ` +
    `${path.relative(ROOT, hiddenStorePath(CORPUS))} (+ package copy)`);
}

const [mode, arg] = process.argv.slice(2);

if (mode === '--from-fixtures') {
  const corpus = JSON.parse(await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'));
  const store = { checks: {}, references: {} };
  for (const task of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const fixtureDir = path.join(CORPUS, task.repoFixture);
    for (const dir of Object.keys(SECTIONS)) {
      let files;
      try {
        files = await walkFiles(path.join(fixtureDir, dir));
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const rel of files) add(store, task.id, path.posix.join(dir, rel), await readFile(path.join(fixtureDir, dir, rel), 'utf8'));
    }
  }
  await write(store);
} else if (mode === 'build' && arg !== undefined) {
  const source = path.resolve(arg);
  const store = { checks: {}, references: {} };
  for (const taskId of (await readdir(source, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const rel of await walkFiles(path.join(source, taskId))) {
      const head = rel.split('/')[0];
      if (SECTIONS[head] === undefined) continue;
      add(store, taskId, rel, await readFile(path.join(source, taskId, rel), 'utf8'));
    }
  }
  await write(store);
} else if (mode === 'extract' && arg !== undefined) {
  const dest = path.resolve(arg);
  await rm(dest, { recursive: true, force: true });
  const store = await loadHiddenStore(CORPUS);
  let n = 0;
  for (const section of ['checks', 'references']) {
    for (const taskId of Object.keys(store[section]).sort()) {
      for (const rel of hiddenPaths(store, section, taskId)) {
        const target = path.join(dest, taskId, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, readHiddenFile(store, section, taskId, rel), 'utf8');
        n++;
      }
    }
  }
  console.log(`[hidden-store] extracted ${n} file(s) to ${dest}`);
} else {
  console.error('usage: build-hidden-store.mjs --from-fixtures | build <sourceRoot> | extract <destRoot>');
  process.exitCode = 2;
}
