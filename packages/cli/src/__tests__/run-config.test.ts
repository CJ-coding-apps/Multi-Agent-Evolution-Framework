import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { driveRun, messageOf, registryOf, unavailableAdapter } from './runFixture.js';

// ORACLE: WP-2.5 / WP-2.10 rules 1–2 — `maf run` reads .maf/config.yaml, and a flag the user typed
// outranks it. Commander used to default `--adapter` to claude, so the file's adapter could never
// win, and a typed `--adapter claude` could never be told from no flag at all.

const adapters = registryOf(unavailableAdapter('claude'), unavailableAdapter('from-file'), unavailableAdapter('typed'));

async function withProject(config: string | undefined, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-run-config-'));
  try {
    if (config !== undefined) {
      await mkdir(path.join(dir, '.maf'), { recursive: true });
      await writeFile(path.join(dir, '.maf', 'config.yaml'), config, 'utf8');
    }
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('config.yaml chooses the adapter when --adapter is not typed', async () => {
  await withProject('adapter: from-file\n', async (dir) => {
    const run = await driveRun(['task', '--dir', dir], { adapters });
    assert.match(run.out, /\| adapter: from-file \|/);
    assert.match(messageOf(run.error), /Adapter "from-file" is not available/);
  });
});

test('a typed --adapter outranks config.yaml, even when it names the built-in default', async () => {
  await withProject('adapter: from-file\n', async (dir) => {
    for (const name of ['typed', 'claude']) {
      const run = await driveRun(['task', '--dir', dir, '--adapter', name], { adapters });
      assert.match(messageOf(run.error), new RegExp(`Adapter "${name}" is not available`), `--adapter ${name}`);
    }
  });
});

test('with neither a flag nor a file, the built-in default applies, and the run says so once on its own stderr', async () => {
  await withProject(undefined, async (dir) => {
    const run = await driveRun(['task', '--dir', dir], { adapters });
    assert.match(messageOf(run.error), /Adapter "claude" is not available/);
    const said = run.err.split('\n').filter((l) => l.includes('config:'));
    assert.deepEqual(said, [`[maf] config: no config file at ${JSON.stringify(path.join(dir, '.maf', 'config.yaml'))}; using the built-in defaults.`]);
  });
});

test('a config file that is there is never reported missing', async () => {
  await withProject('adapter: from-file\n', async (dir) => {
    const run = await driveRun(['task', '--dir', dir], { adapters });
    assert.doesNotMatch(run.err, /no config file/);
  });
});

test('a config.yaml that does not validate stops the run before an adapter is chosen', async () => {
  await withProject('adapter: from-file\nworktree: sometimes\n', async (dir) => {
    const run = await driveRun(['task', '--dir', dir], { adapters });
    assert.match(messageOf(run.error), /failed validation, so the run cannot start/);
    assert.equal(run.out, '', 'nothing ran, not even the banner');
  });
});
