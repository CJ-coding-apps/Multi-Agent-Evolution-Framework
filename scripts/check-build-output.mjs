#!/usr/bin/env node
// A5 (work order item 5) — the build-output guard.
//
// `tsc` reports success and emits nothing when its incremental state file says the tree
// is already built, and the state file used to live BESIDE tsconfig.json, outside the
// directory anyone deletes. So `rm -rf packages/*/dist && pnpm build` printed "Done" for
// every package while 4 packages produced no output at all, and the only symptom was
// downstream "Cannot find module '@maf/types'" errors in whichever package built next.
// The tsBuildInfoFile fix moves the state into dist/ so deleting dist is a clean build;
// this guard is what proves it, because the failure mode is silence and silence cannot
// be read off a build log.
//
// The assertion is each package's declared `main`, not a hardcoded dist/index.js: `main`
// is the file a consumer actually imports, and it is the one place the answer is written
// down (`@maf/cli` legitimately points at dist/main.js).

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function workspacePatterns() {
  const text = await readFile(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  return [...text.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

async function packageDirs() {
  const dirs = [];
  for (const pattern of await workspacePatterns()) {
    const parent = path.join(ROOT, path.dirname(pattern));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const dir = path.join(parent, entry.name);
      await stat(path.join(dir, 'package.json')).then(() => dirs.push(dir), () => undefined);
    }
  }
  return dirs.sort();
}

const dirs = await packageDirs();
const problems = [];
let checked = 0;

for (const dir of dirs) {
  const relative = path.relative(ROOT, dir);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const name = typeof pkg.name === 'string' ? pkg.name : relative;
  const main = pkg.main;

  if (typeof main !== 'string' || main.trim() === '') {
    problems.push(`${name} (${relative}): declares no "main", so nothing can import it`);
    continue;
  }
  const entry = path.join(dir, main);
  try {
    await stat(entry);
  } catch {
    problems.push(`${name} (${relative}): ${main} is missing after the build — tsc reported success and emitted nothing`);
    continue;
  }
  checked += 1;
}

for (const problem of problems) console.error(`FAIL  ${problem}`);

console.log(`build-output guard: ${checked}/${dirs.length} packages emitted the entry point their "main" names`);

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) produced no usable build output. Run "pnpm build" first if you have not,`);
  console.error('and if that does not fix it, check for a stale tsBuildInfoFile outside dist/.');
  process.exit(1);
}
console.log('OK');
