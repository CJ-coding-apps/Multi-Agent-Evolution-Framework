#!/usr/bin/env node
// A workspace dependency guard, in two parts.
//
// (1) The @maf package graph must be ACYCLIC. pnpm tolerates a cycle between workspace
//     packages, and TypeScript project references do not: a cycle makes `tsc -b` fail in a
//     way that looks like a stale build rather than a design error. It is also the failure
//     that arrives by accident — a shared helper "just" needs one function from the package
//     that already depends on it.
//
// (2) @maf/git-ops must stay a leaf: its only @maf dependency is @maf/types. It is the
//     package that touches the user's repository, so it is the one every other package may
//     safely depend on; the reverse edge is what would make a cycle possible at all. This is
//     the rule the eval-harness -> git-ops edge was added under ("git-ops must never depend
//     on eval-harness"), stated as the invariant rather than as one forbidden pair.
//
// Both checks read package.json only — no install, no pnpm API, no network.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEAF = '@maf/git-ops';
const LEAF_ALLOWED = new Set(['@maf/types']);

async function workspacePatterns() {
  const text = await readFile(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  return [...text.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

async function workspacePackages() {
  const packages = new Map();
  for (const pattern of await workspacePatterns()) {
    const parent = path.join(ROOT, path.dirname(pattern));
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const dir = path.join(parent, entry.name);
      let pkg;
      try {
        pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (typeof pkg.name !== 'string') continue;
      // Only workspace: links are internal edges; a published version is an outside package.
      const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
        .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
        .map(([name]) => name)
        .sort();
      packages.set(pkg.name, { dir: path.relative(ROOT, dir), deps });
    }
  }
  return packages;
}

const packages = await workspacePackages();
const problems = [];

// ── (1) acyclic ──────────────────────────────────────────────────────────────
const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map();

function visit(name, stack) {
  colour.set(name, GREY);
  for (const dep of packages.get(name).deps) {
    if (!packages.has(dep)) continue;
    const c = colour.get(dep) ?? WHITE;
    if (c === GREY) {
      const cycle = [...stack.slice(stack.indexOf(dep)), dep];
      problems.push(`dependency cycle: ${cycle.join(' -> ')}`);
      continue;
    }
    if (c === WHITE) visit(dep, [...stack, dep]);
  }
  colour.set(name, BLACK);
}

for (const name of [...packages.keys()].sort()) {
  if ((colour.get(name) ?? WHITE) === WHITE) visit(name, [name]);
}

// ── (2) git-ops stays a leaf ─────────────────────────────────────────────────
const leaf = packages.get(LEAF);
if (!leaf) {
  problems.push(`${LEAF} is not a workspace package — this guard is not watching anything`);
} else {
  for (const dep of leaf.deps) {
    if (!LEAF_ALLOWED.has(dep)) {
      problems.push(`${LEAF} depends on ${dep}; its only @maf dependency may be ${[...LEAF_ALLOWED].join(', ')}`);
    }
  }
}

for (const problem of problems) console.error(`FAIL  ${problem}`);

const edges = [...packages.values()].reduce((n, p) => n + p.deps.filter((d) => packages.has(d)).length, 0);
console.log(`workspace-deps guard: ${packages.size} packages, ${edges} internal edges, acyclic`);
console.log(`${LEAF} depends on: ${leaf ? leaf.deps.join(', ') || '(nothing)' : 'MISSING'}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} workspace dependency violation(s).`);
  process.exit(1);
}
console.log('OK');
