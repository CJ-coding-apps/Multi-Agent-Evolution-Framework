import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { runIsolatedGit } from '@maf/git-ops';
import { MAF_DIR_GITIGNORE } from '../ensureMafDir.js';
import { initFiles, runInit, registerInitCommand } from '../commands/init.js';
import type { InitDeps } from '../commands/init.js';
import { readAsset } from '../assets.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { collector } from './runFixture.js';

// ORACLE (WP-P1, acceptance 3): an installed `maf` must be able to set a repository up for a run.
// `maf init` writes the same policy, roles, config and prompts the package runs from (D-49), plus the
// `.gitignore` that keeps runtime state out of the user's history; running it twice must not clobber
// a file the user has since edited, and `--force` is the explicit way to replace one. It refuses a
// directory a run could not use — no git, or no commit — and it names the next command instead of
// leaving the user to guess.

/** `maf init <args>` through commander, as main.ts registers it, collecting what it printed. */
async function driveInit(args: readonly string[], deps: InitDeps = {}) {
  const out = collector();
  const program = new Command();
  program.exitOverride();
  registerInitCommand(program, { out, ...deps });
  let error: unknown;
  try {
    await program.parseAsync(['init', ...args], { from: 'user' });
  } catch (err: unknown) {
    error = err;
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { out: out.text(), ...(error !== undefined ? { error } : {}) };
}

/** The files in the order `init` reports them, with the separators a printed line carries. */
async function shipped(): Promise<string[]> {
  return (await initFiles()).map((relative) => relative.split(path.sep).join('/'));
}

async function absent(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

test('a fresh repository gets every shipped .maf file, byte-identical to the package, plus the state .gitignore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-fresh-'));
  try {
    const repo = await createDemoFixture(root);
    const run = await driveInit(['--dir', repo]);
    assert.equal(run.error, undefined, run.out);

    const files = await shipped();
    assert.ok(files.length >= 5, `init writes at least five files; it wrote ${files.length}`);
    // F1: the default harness ships with the package and `init` copies it, so a repository that ran
    // `init` can run `goldens run` with nothing else brought in.
    assert.ok(
      files.some((f) => /^harnesses\/default-[0-9a-f]{64}\.json$/.test(f)),
      `init writes the packaged default harness; it wrote ${files.join(', ')}`,
    );

    for (const relative of files) {
      assert.equal(
        await readFile(path.join(repo, '.maf', relative), 'utf8'),
        await readAsset(relative),
        `.maf/${relative} is the package's own bytes, not a copy that can drift`,
      );
      assert.ok(
        run.out.includes(`[maf] init: wrote .maf/${relative}`),
        `the report names .maf/${relative}: ${run.out}`,
      );
    }

    assert.equal(
      await readFile(path.join(repo, '.maf', '.gitignore'), 'utf8'),
      MAF_DIR_GITIGNORE,
      'the state .gitignore is there, so a run leaves `git status` clean',
    );
    // F9(a): the state `.gitignore` is named in the report too, so a reader sees which file keeps
    // runtime state out of their history rather than finding an unexplained entry.
    assert.ok(run.out.includes('[maf] init: wrote .maf/.gitignore'), run.out);
    assert.match(run.out, /^Next steps:$/m);
    assert.ok(run.out.includes('export MAF_SIGNING_KEY="$(openssl rand -hex 32)"'), run.out);
    assert.match(run.out, /^\s+maf run /m, 'and the command that does the work');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a second init writes nothing and names each file it kept', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-twice-'));
  try {
    const repo = await createDemoFixture(root);
    const first = await runInit({ dir: repo, out: collector() });
    assert.equal(first.skipped.length, 0, 'the first run has nothing to keep');

    // A file the user has since changed is the case "kept" exists for.
    const policy = path.join(repo, '.maf', 'policy.yaml');
    await writeFile(policy, '# mine now\n', 'utf8');

    const second = await driveInit(['--dir', repo]);
    assert.equal(second.error, undefined, second.out);
    assert.equal(await readFile(policy, 'utf8'), '# mine now\n', 'init does not clobber an existing file');
    assert.ok(second.out.includes('[maf] init: kept .maf/.gitignore (already exists)'), second.out);
    assert.ok(!second.out.includes('[maf] init: wrote'), `nothing was written: ${second.out}`);
    for (const relative of await shipped()) {
      assert.ok(
        second.out.includes(`[maf] init: kept .maf/${relative} (already exists; use --force to overwrite)`),
        `the report names .maf/${relative} as kept: ${second.out}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('--force overwrites the files init owns, restoring the shipped bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-force-'));
  try {
    const repo = await createDemoFixture(root);
    await runInit({ dir: repo, out: collector() });
    for (const relative of ['policy.yaml', 'prompts/coder.md']) {
      await writeFile(path.join(repo, '.maf', relative), 'edited\n', 'utf8');
    }

    const forced = await driveInit(['--dir', repo, '--force']);
    assert.equal(forced.error, undefined, forced.out);
    for (const relative of ['policy.yaml', 'prompts/coder.md']) {
      assert.equal(await readFile(path.join(repo, '.maf', relative), 'utf8'), await readAsset(relative), relative);
      assert.ok(forced.out.includes(`[maf] init: wrote .maf/${relative}`), forced.out);
    }
    // `.gitignore` is the one file `--force` does not own: an existing one is the user's to keep.
    assert.doesNotMatch(forced.out, /\[maf\] init: kept \.maf\/(?!\.gitignore)/, forced.out);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a directory that is not a git repository is refused, and nothing is written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-nogit-'));
  try {
    await assert.rejects(
      runInit({ dir: root, out: collector() }),
      /is not inside a git repository\..*must be in a git repository with at least one commit/s,
    );
    assert.ok(await absent(path.join(root, '.maf')), 'a refused init leaves no .maf behind');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a repository with no commits is refused, because a run has no HEAD to start from', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-nocommit-'));
  try {
    await runIsolatedGit(root, ['init', '-q']);
    await assert.rejects(
      runInit({ dir: root, out: collector() }),
      /has no commits yet\..*must be in a git repository with at least one commit/s,
    );
    assert.ok(await absent(path.join(root, '.maf')));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ORACLE (F6). `--force` says "replace the files init owns"; it does not say "write wherever a link
// points". A symlinked `.maf`, or a symlinked destination inside it, would carry the write out of the
// repository the user named — and in the second case silently replace a file outside it.

test('a symlinked .maf is refused, with or without --force, before anything is written through it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-symlink-dir-'));
  try {
    const repo = await createDemoFixture(root);
    const outside = path.join(root, 'outside-maf');
    await mkdir(outside);
    await symlink(outside, path.join(repo, '.maf'));

    for (const force of [false, true]) {
      await assert.rejects(
        runInit({ dir: repo, ...(force ? { force: true } : {}), out: collector() }),
        /\.maf is a symbolic link; refusing to write through it/,
        `--force must not make a symlinked .maf acceptable (force=${force})`,
      );
      assert.deepEqual(await readdir(outside), [], 'the link target gains no file');
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a symlinked destination inside .maf is refused, with or without --force, and its target is unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-symlink-file-'));
  const original = "the user's file outside the repository\n";
  try {
    const repo = await createDemoFixture(root);
    const outside = path.join(root, 'outside-policy.yaml');
    await writeFile(outside, original, 'utf8');
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await symlink(outside, path.join(repo, '.maf', 'policy.yaml'));

    for (const force of [false, true]) {
      await assert.rejects(
        runInit({ dir: repo, ...(force ? { force: true } : {}), out: collector() }),
        /policy\.yaml is a symbolic link; refusing to write through it/,
        `--force must not overwrite through a link (force=${force})`,
      );
      assert.equal(await readFile(outside, 'utf8'), original, 'the link target is left as it was');
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// N4. F6's refusal used to run inside the write loop, so a symlinked `prompts/` was found only
// after policy.yaml, roles.yaml, config.yaml and .gitignore had been written. Every destination is
// checked before the first write now, so the refusal leaves the repository exactly as it was.

test('a symlinked prompts/ inside .maf is refused before any file is written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-preflight-'));
  try {
    const repo = await createDemoFixture(root);
    const outside = path.join(root, 'outside-prompts');
    await mkdir(outside);
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await symlink(outside, path.join(repo, '.maf', 'prompts'));

    for (const force of [false, true]) {
      await assert.rejects(
        runInit({ dir: repo, ...(force ? { force: true } : {}), out: collector() }),
        /prompts is a symbolic link; refusing to write through it/,
        `force=${force}`,
      );
      assert.deepEqual(
        await readdir(path.join(repo, '.maf')),
        ['prompts'],
        `nothing was written before the refusal (force=${force})`,
      );
      assert.deepEqual(await readdir(outside), [], 'the link target gains no file');
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// N2 (F6). The write path is a sibling temp file then `rename`, and nothing above would notice it
// becoming a direct write: the symlink refusals happen before either. Injecting the failure at
// `rename` (the compiled module reads the property at call time) pins both halves — the destination
// keeps the bytes it had, and the temp file is removed.

test('a failed rename leaves the destination it would have replaced intact and removes the temp file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-rename-'));
  // The compiled init.js resolves `rename` off this same module object at call time.
  const fsp = require('node:fs/promises') as { rename: (from: string, to: string) => Promise<void> };
  try {
    const repo = await createDemoFixture(root);
    await runInit({ dir: repo, out: collector() });
    const destination = path.join(repo, '.maf', 'policy.yaml');
    await writeFile(destination, '# mine now\n', 'utf8');

    const realRename = fsp.rename;
    let attempts = 0;
    fsp.rename = async () => {
      attempts += 1;
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    };
    try {
      await assert.rejects(runInit({ dir: repo, force: true, out: collector() }), /injected rename failure/);
    } finally {
      fsp.rename = realRename;
    }

    assert.equal(attempts, 1, 'the write goes through rename, not directly to the destination');
    assert.equal(await readFile(destination, 'utf8'), '# mine now\n', 'a failed write does not truncate what it replaces');
    assert.deepEqual(
      (await readdir(path.join(repo, '.maf'))).filter((name) => name.endsWith('.tmp')),
      [],
      'the temp file is removed when the rename fails',
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ORACLE (F9b). `.maf/` belongs at the root of a work tree. Inside `.git`, `git rev-parse` succeeds
// and answers `false`; a run there has no working tree to review and `init` would write into git's
// own directory, so it is refused rather than attempted.

test('init into .git, or a directory inside it, is refused as not a work tree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-init-gitdir-'));
  try {
    const repo = await createDemoFixture(root);
    for (const dir of [path.join(repo, '.git'), path.join(repo, '.git', 'refs')]) {
      await assert.rejects(
        runInit({ dir, out: collector() }),
        /is inside a git directory.*not a work tree/s,
        `init -d ${dir}`,
      );
      assert.ok(await absent(path.join(dir, '.maf')), `a refused init leaves no .maf in ${dir}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
