#!/usr/bin/env node
/**
 * Builds the publishable package for the CLI: `@cj-coding-apps/maf`.
 *
 * The 26 internal `@maf/*` packages are `private` and are not published; they are bundled into one
 * `dist/main.js`. The six third-party runtime dependencies stay real `dependencies`, pinned to the
 * versions this workspace's lockfile resolved, because two of them (`better-sqlite3`, `kuzu`) carry
 * native code that must be installed against the user's Node, and the rest are shared with the
 * packages they serve. Nothing named `workspace:` or `@maf/*` may reach the manifest; `pack-check`
 * asserts that on the packed artifact.
 *
 * The output is a staging directory, not a tarball: `npm pack` run there names the artifact and is
 * the same command a publisher would use, and the file list is then npm's own. Everything beside the
 * manifest is what the repository ships — `README.md`, `LICENSE` — plus `dist/` and `assets/`.
 *
 * Usage: node scripts/pack-package.mjs
 */
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The name CJ owns on npm. The bin stays `maf`. */
export const PACKAGE_NAME = '@cj-coding-apps/maf';

/**
 * The runtime dependencies that stay outside the bundle. Two are native (`better-sqlite3`, `kuzu`),
 * so they cannot be bundled; the other four are shared with the packages that use them. The list is
 * the spec's, measured against the workspace: every one of them is imported by non-test code.
 */
export const EXTERNAL_DEPENDENCIES = [
  'better-sqlite3',
  'commander',
  'kuzu',
  'minimatch',
  'yaml',
  'zod',
];

/** Where the staging directory is built. Under `node_modules/`, which git already ignores. */
export function stagingDir() {
  return path.join(ROOT, 'node_modules', '.maf-pack', 'package');
}

/**
 * The version the workspace resolved for each external dependency, read from `pnpm-lock.yaml` (its
 * `packages:` and `snapshots:` sections both carry it). Each dependency must resolve to exactly one
 * version here; two would mean the bundle's single copy and the manifest's pin could disagree.
 */
export async function lockedVersions() {
  const lock = await readFile(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const versions = {};
  for (const name of EXTERNAL_DEPENDENCIES) {
    const found = new Set();
    const pattern = new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([^:\\s]+):$`, 'gm');
    for (const match of lock.matchAll(pattern)) found.add(match[1]);
    if (found.size !== 1) {
      throw new Error(
        `pack-package: ${name} resolves to ${found.size === 0 ? 'no version' : [...found].join(', ')} in ` +
        `pnpm-lock.yaml; the manifest needs exactly one`,
      );
    }
    versions[name] = [...found][0];
  }
  return versions;
}

/** The manifest npm publishes: no workspace links, no private packages, no build-time fields. */
export async function manifest() {
  const cli = JSON.parse(await readFile(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  const dependencies = await lockedVersions();
  return {
    name: PACKAGE_NAME,
    version: cli.version,
    description: 'CLI-agnostic orchestration for code-modifying agents: a planned DAG of governed, attested agent tasks.',
    license: 'Apache-2.0',
    engines: { node: '>=22' },
    bin: { maf: './dist/main.js' },
    main: './dist/main.js',
    files: ['dist/', 'assets/'],
    repository: { type: 'git', url: 'git+https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework.git' },
    homepage: 'https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework#readme',
    keywords: ['agents', 'multi-agent', 'orchestration', 'attestation', 'policy', 'llm'],
    dependencies,
  };
}

/**
 * Resolves `@maf/*` to its TypeScript source rather than its `dist/`, so a bundle can never ship a
 * stale build: the monorepo's per-package `tsc` does not prune or reference dependencies, and a
 * packaging step that read `dist/` would quietly pack whatever a previous branch left there.
 */
const internalSource = {
  name: 'maf-internal-source',
  setup(esbuild) {
    esbuild.onResolve({ filter: /^@maf\// }, (args) => {
      const name = args.path.slice('@maf/'.length);
      if (name === '' || name.includes('/')) return undefined;
      const dir = name.startsWith('adapter-')
        ? path.join(ROOT, 'packages', 'adapters', name.slice('adapter-'.length))
        : path.join(ROOT, 'packages', name);
      return { path: path.join(dir, 'src', 'index.ts') };
    });
  },
};

/**
 * Writes the staging directory: the bundle, the assets it resolves beside `dist/`, and the two
 * repository files npm copies into every package.
 */
export async function buildPackage() {
  const out = stagingDir();
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'dist'), { recursive: true });

  // `assets/` is a sibling of `dist/`, the arrangement `assetsRoot()` resolves (`__dirname/../assets`).
  await cp(path.join(ROOT, 'packages', 'cli', 'assets'), path.join(out, 'assets'), { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, 'packages', 'cli', 'src', 'main.ts')],
    outfile: path.join(out, 'dist', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The entry's own shebang is preserved by esbuild; the mode below is what makes it runnable.
    external: [...EXTERNAL_DEPENDENCIES],
    plugins: [internalSource],
    logLevel: 'warning',
  });
  await chmod(path.join(out, 'dist', 'main.js'), 0o755);

  const pkg = await manifest();
  await writeFile(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  await copyFile(path.join(ROOT, 'README.md'), path.join(out, 'README.md'));
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));
  return { dir: out, manifest: pkg };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPackage()
    .then(({ dir, manifest: pkg }) => {
      console.log(`[pack] ${pkg.name}@${pkg.version} in ${dir}`);
      console.log('[pack] next: cd there and run `npm pack` (publishing is the maintainer\'s act)');
    })
    .catch((err) => {
      console.error(`[pack] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
