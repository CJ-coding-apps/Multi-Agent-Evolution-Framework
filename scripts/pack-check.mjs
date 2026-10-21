#!/usr/bin/env node
/**
 * Proves the published artifact, not the checkout.
 *
 * `pack-package.mjs` builds what npm would publish. This script takes that staging directory, packs
 * it with npm itself, and then exercises the tarball the way a user gets it: installed into an empty
 * prefix, run from a directory that is not this repository. Every claim here is measured on the
 * installed package, because a check that ran the checkout's `dist/` would pass even when the
 * tarball was missing the assets, the shebang or the manifest's dependencies.
 *
 * What is asserted:
 *   - the tarball holds exactly what was staged — `dist/`, `assets/`, `package.json`, `README.md`,
 *     `LICENSE` — and nothing else;
 *   - the packed manifest carries no `workspace:` link and no `@maf/*` name, and pins the six
 *     external dependencies to the versions this workspace resolved;
 *   - the installed `maf` reports the manifest version, and its bundle keeps the `env -S` shebang
 *     and is executable inside the tarball;
 *   - `maf inprocess-demo` runs end to end;
 *   - `maf init` then `maf goldens run --adapter scripted` works in a repository with no checkout,
 *     after nothing but those two commands: the corpus, the harness and the policy are the ones the
 *     package ships. Nothing is copied in from this repository — seeding a harness here is exactly
 *     how a package that shipped none passed this check before (F1).
 *
 * Usage: node scripts/pack-check.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_DEPENDENCIES, buildPackage } from './pack-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A throwaway key, not a secret: it only makes the goldens sign with a key of their own. */
const THROWAWAY_SIGNING_KEY = 'ci-pack-check-throwaway-signing-key';

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${result.status}\n` +
      `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

/** Every file below `root`, as `/`-separated paths relative to it, sorted. */
async function walk(root, rel = '') {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = rel === '' ? entry.name : path.join(rel, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, next));
    else if (entry.isFile()) files.push(next.split(path.sep).join('/'));
  }
  return files.sort();
}

async function remove(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function packCheck() {
  const { dir: staging, manifest: pkg } = await buildPackage();
  const work = await mkdtemp(path.join(tmpdir(), 'maf-pack-check-'));
  const prefix = path.join(work, 'prefix');
  try {
    // 1. The manifest is publishable: no workspace links, no private package names, pinned deps.
    const manifestText = JSON.stringify(pkg);
    if (manifestText.includes('workspace:')) fail('the manifest links a workspace dependency');
    if (manifestText.includes('@maf/')) fail('the manifest names an internal @maf/* package');
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    if (JSON.stringify(deps) !== JSON.stringify([...EXTERNAL_DEPENDENCIES].sort())) {
      fail(`the manifest's dependencies are ${deps.join(', ')}; expected ${EXTERNAL_DEPENDENCIES.join(', ')}`);
    }
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (version.startsWith('workspace:') || !/^\d/.test(version)) {
        fail(`dependency ${name} is not pinned to a resolved version: ${version}`);
      }
    }

    // 2. npm itself names the artifact and lists what it will publish.
    const packed = run('npm', ['pack', '--json', '--pack-destination', work], { cwd: staging });
    const packInfo = JSON.parse(packed.stdout)[0];
    const tarball = path.join(work, packInfo.filename);

    const staged = await walk(staging);
    const shipped = packInfo.files.map((file) => file.path.split(path.sep).join('/')).sort();
    if (JSON.stringify(shipped) !== JSON.stringify(staged)) {
      const missing = staged.filter((file) => !shipped.includes(file));
      const extra = shipped.filter((file) => !staged.includes(file));
      fail(
        'the tarball is not exactly the staging directory:' +
        (missing.length > 0 ? `\n  missing: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `\n  extra: ${extra.join(', ')}` : ''),
      );
    }
    for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/main.js']) {
      if (!shipped.includes(required)) fail(`the tarball does not ship ${required}`);
    }
    // The goldens proof below depends on this file existing inside the package (F1); naming it here
    // means a missing harness is reported as a packaging defect, not as a mystifying goldens error.
    if (!shipped.some((file) => /^assets\/harnesses\/default-[0-9a-f]{64}\.json$/.test(file))) {
      fail('the tarball does not ship a default harness (assets/harnesses/default-<sha>.json)');
    }
    for (const file of shipped) {
      if (/\.(ts|map|d\.ts)$/.test(file) || file.startsWith('src/')) {
        fail(`the tarball ships build input: ${file}`);
      }
    }

    // 3. The packed manifest is the one that was checked above.
    const packedManifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']).stdout);
    if (JSON.stringify(packedManifest) !== JSON.stringify(pkg)) {
      fail('the packed package.json differs from the manifest that was validated');
    }

    // 4. The entry point keeps its shebang and arrives executable.
    const entry = run('tar', ['-xzOf', tarball, 'package/dist/main.js']).stdout;
    const firstLine = entry.split('\n', 1)[0];
    if (!firstLine.startsWith('#!/usr/bin/env -S node')) {
      fail(`the packed entry point's first line is ${JSON.stringify(firstLine)}`);
    }
    const listing = run('tar', ['-tvzf', tarball, 'package/dist/main.js']).stdout;
    if (!/^-rwx/.test(listing)) fail(`the packed entry point is not executable: ${listing.trim()}`);

    // 5. Install into an empty prefix — the user's path — and run what the README says to run.
    await mkdir(prefix, { recursive: true });
    run('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball]);
    const maf = path.join(prefix, 'bin', 'maf');

    const version = run(maf, ['--version']).stdout.trim();
    if (version !== pkg.version) fail(`installed maf reports ${version}; the package is ${pkg.version}`);

    const demoDir = path.join(work, 'demo');
    await mkdir(demoDir, { recursive: true });
    const demo = run(maf, ['inprocess-demo'], { cwd: demoDir }).stdout;
    if (!demo.includes('[demo] OK:')) fail(`inprocess-demo did not report success:\n${demo}`);

    // 6. Goldens from a repository that has no checkout and has run exactly `maf init`: the corpus,
    // the harness and the policy the package ships must carry the run. Nothing is seeded from this
    // repository, and no harness is imported or set current — a user who types what the README says
    // gets no such step (F1).
    const repo = path.join(work, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'README.md'), 'pack check\n', 'utf8');
    run('git', ['init', '-q'], { cwd: repo });
    run('git', ['config', 'user.email', 'pack-check@example.invalid'], { cwd: repo });
    run('git', ['config', 'user.name', 'pack check'], { cwd: repo });
    run('git', ['add', '-A'], { cwd: repo });
    run('git', ['commit', '-qm', 'pack check'], { cwd: repo });

    const env = { ...process.env, MAF_SIGNING_KEY: THROWAWAY_SIGNING_KEY };
    const init = run(maf, ['init'], { cwd: repo, env }).stdout;
    if (!/\.maf\/harnesses\/default-[0-9a-f]{64}\.json/.test(init)) {
      fail(`maf init did not write the default harness:\n${init}`);
    }
    const goldens = run(maf, ['goldens', 'run', '--adapter', 'scripted'], { cwd: repo, env }).stdout;
    if (!/\[maf\] goldens: solved \d+\/\d+/.test(goldens)) {
      fail(`goldens did not report a score:\n${goldens}`);
    }
    if (!goldens.includes('using the corpus shipped with maf')) {
      fail(`goldens did not fall back to the packaged corpus:\n${goldens}`);
    }

    console.log(`[pack-check] ${pkg.name}@${pkg.version}: ${shipped.length} files, installed and run`);
    console.log(`[pack-check] ${version} · inprocess-demo · goldens ${goldens.match(/solved \d+\/\d+/)[0]}`);
  } finally {
    await remove(work);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packCheck().catch((err) => {
    console.error(`[pack-check] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
