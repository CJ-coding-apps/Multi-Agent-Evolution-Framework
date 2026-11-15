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
 *       Writes the store's plaintext back out for editing, without the canary lines, so that
 *       `extract`, edit, `build` round-trips. Extract, edit, build.
 *
 * The canonical store is mirrored byte-for-byte into `packages/cli/assets/goldens/`, which the
 * package's asset test requires. Run `pnpm -r build` first: the encoder is the package's own, so
 * the store this writes and the store a run reads cannot disagree about the format.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'tests', 'goldens');
const ASSETS = path.join(ROOT, 'packages', 'cli', 'assets', 'goldens');

const harness = await import(pathToFileURL(path.join(ROOT, 'packages', 'eval-harness', 'dist', 'index.js')).href);
const {
  HIDDEN_STORE_FILE, HIDDEN_STORE_VERSION, encodeHidden, injectCanary, loadHiddenStore, hiddenPaths,
  readHiddenFile, hiddenStorePath, captureExpectations, runHiddenCheck, compareObservations,
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
  const out = {
    version: HIDDEN_STORE_VERSION, encoding: 'gzip+base64', checks: {}, references: {}, expectations: {},
  };
  for (const section of ['checks', 'references', 'expectations']) {
    for (const taskId of Object.keys(store[section]).sort()) {
      out[section][taskId] = {};
      for (const rel of Object.keys(store[section][taskId]).sort())
        out[section][taskId][rel] = store[section][taskId][rel];
    }
  }
  return out;
}

/**
 * R7-H2: computes a task's expected values by running its check against the reference solution
 * (held-out tasks) or its visible test against the fixture's starter (train tasks). The result is
 * what the *check* asserts, not what the solution returned; only a trusted run may say what the
 * expected value is. For a train task the starter may throw before the last assertion, so the run
 * is retried with module proxies that absorb the calls whose values are not needed.
 */
async function expectationsFor(task, corpusDir, referenceFiles, checkSource) {
  const fixtureDir = path.join(corpusDir, task.repoFixture);
  const expectedKey = task.hiddenChecks?.[0] ?? (task.verifiers.find((v) => v.kind === 'test-script')?.args[0]);
  if (expectedKey === undefined) return undefined;
  const stageDir = await mkdtemp(path.join(tmpdir(), 'maf-expect-'));
  try {
    await cp(fixtureDir, stageDir, {
      recursive: true,
      filter: (src) => {
        const segments = path.relative(fixtureDir, src).split(path.sep);
        return !segments.some((seg) => seg === '.checks' || seg === '.reference' || seg === '.git');
      },
    });
    for (const [rel, text] of referenceFiles)
      await writeText(path.join(stageDir, rel.slice('.reference/'.length)), text);

    const source = checkSource ?? await readFile(path.join(fixtureDir, expectedKey), 'utf8');
    let captured = await captureExpectations(source, stageDir, { proxy: false });
    if (captured.failure !== undefined)
      captured = await captureExpectations(source, stageDir, { proxy: true });
    if (captured.failure !== undefined)
      throw new Error(`${task.id}: cannot record expectations: ${captured.failure}`);
    // An exit-status check (the seed `coder-*` tasks: no assertion, `process.exit(1)` on failure)
    // is judged by whether it exits at all, so its expectations are empty on purpose. Any other
    // check that records nothing cannot judge a run and is refused.
    if (captured.expectations.length === 0 && captured.exitStyle !== true)
      throw new Error(`${task.id}: the check made no assertions, so it cannot judge a run`);
    if (task.hiddenChecks !== undefined && captured.expectations.length === 0)
      throw new Error(`${task.id}: a held-out check must assert something, not only exit`);

    // A held-out task ships its reference to prove the check solvable: it must pass the same
    // boundary the run will face, against these very expectations.
    if (task.hiddenChecks !== undefined) {
      const run = await runHiddenCheck(source, stageDir);
      if (run.failure !== undefined)
        throw new Error(`${task.id}: the reference does not finish the check: ${run.failure}`);
      const verdict = compareObservations(run.observations, captured.expectations);
      if (!verdict.passed) throw new Error(`${task.id}: the reference fails its own check: ${verdict.detail}`);
    }
    return { key: expectedKey, expectations: captured.expectations };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/**
 * Adds every scored task's expectations to the store. `entriesForTask(taskId)` returns that task's
 * plaintext hidden files as `{ checks, references }` maps of store-relative path to text — from the
 * build tree or from a fixture's hidden directories; a train task has neither.
 */
async function addExpectations(store, entriesForTask) {
  const corpus = JSON.parse(await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'));
  for (const task of corpus) {
    if (!task.verifiers.some((v) => v.kind === 'test-script')) continue;
    const { checks, references } = await entriesForTask(task.id);
    const checkRel = [...checks.keys()].sort()[0];
    const result = await expectationsFor(
      task, CORPUS, [...references.entries()],
      checkRel === undefined ? undefined : checks.get(checkRel),
    );
    if (result === undefined) continue;
    store.expectations[task.id] ??= {};
    store.expectations[task.id][result.key] = encodeHidden(JSON.stringify(result.expectations));
  }
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
  const store = { checks: {}, references: {}, expectations: {} };
  const entries = new Map();
  for (const task of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const fixtureDir = path.join(CORPUS, task.repoFixture);
    const checks = new Map();
    const references = new Map();
    for (const dir of Object.keys(SECTIONS)) {
      let files;
      try {
        files = await walkFiles(path.join(fixtureDir, dir));
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const rel of files) {
        const text = await readFile(path.join(fixtureDir, dir, rel), 'utf8');
        add(store, task.id, path.posix.join(dir, rel), text);
        (dir === '.checks' ? checks : references).set(path.posix.join(dir, rel), text);
      }
    }
    entries.set(task.id, { checks, references });
  }
  await addExpectations(store, async (taskId) => entries.get(taskId) ?? { checks: new Map(), references: new Map() });
  await write(store);
} else if (mode === 'build' && arg !== undefined) {
  const source = path.resolve(arg);
  const store = { checks: {}, references: {}, expectations: {} };
  const entries = new Map();
  for (const taskId of (await readdir(source, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const checks = new Map();
    const references = new Map();
    for (const rel of await walkFiles(path.join(source, taskId))) {
      const head = rel.split('/')[0];
      if (SECTIONS[head] === undefined) continue;
      const text = await readFile(path.join(source, taskId, rel), 'utf8');
      add(store, taskId, rel, text);
      (head === '.checks' ? checks : references).set(rel, text);
    }
    entries.set(taskId, { checks, references });
  }
  await addExpectations(store, async (taskId) => entries.get(taskId) ?? { checks: new Map(), references: new Map() });
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
        // R6-H2: extract used to write the canary line back out, and `build` refuses a file that
        // already carries one — so the documented extract/edit/build cycle could not run. The
        // plaintext is what is being edited; the canary is derived per task and path at build time.
        await writeFile(target, harness.withoutCanary(readHiddenFile(store, section, taskId, rel)), 'utf8');
        n++;
      }
    }
  }
  console.log(`[hidden-store] extracted ${n} file(s) to ${dest}`);
} else {
  console.error('usage: build-hidden-store.mjs --from-fixtures | build <sourceRoot> | extract <destRoot>');
  process.exitCode = 2;
}
