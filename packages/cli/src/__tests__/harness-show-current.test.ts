import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type { HarnessConfig } from '@maf/harness-config';
import { registerHarnessCommand } from '../commands/harness.js';

// ORACLE: S6 (WP-3.15) — `maf harness show current` answers the question it is asked. With no
// CURRENT, a plain run adopts `legacy-default` minted from the roles file as it is now (or the
// built-in set when there is no file, D-08), and `show` names that harness instead of failing with
// "No harness found for ref \"current\"". It writes nothing: asking what would run cannot change it.

/** Runs `maf harness <args>`, returning stdout lines, stderr lines and the rejection if any. */
async function maf(args: string[]): Promise<{ out: string[]; err: string[]; error?: unknown }> {
  const program = new Command().exitOverride();
  registerHarnessCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.join(' ')); };
  let rejection: unknown;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (e: unknown) {
    rejection = e;
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out, err, ...(rejection !== undefined ? { error: rejection } : {}) };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

test('show current with no CURRENT names the harness a plain run adopts, and writes nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-show-current-none-'));
  try {
    // No `.maf` at all: the built-in set is the roles file's stand-in (D-08).
    const { out, err, error } = await maf(['harness', 'show', 'current', '-d', root]);
    assert.equal(error, undefined);
    const cfg = JSON.parse(out.join('\n')) as HarnessConfig;
    assert.equal(cfg.id, 'legacy-default');
    assert.match(cfg.sha, /^[0-9a-f]{64}$/);
    assert.ok(
      cfg.roleSet.roles.some((r) => r.role === 'coder' && r.systemPrompt !== undefined),
      'the carried role set inlines its prompts, so its sha covers what would dispatch',
    );
    assert.equal(err.length, 1, 'one note says CURRENT is absent, on stderr');
    assert.match(err[0] as string, /no CURRENT/);
    assert.ok((err[0] as string).includes(cfg.sha.slice(0, 8)), 'and names the harness');
    assert.equal(await exists(path.join(root, '.maf')), false, 'show writes nothing, not even .maf/');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('with a roles file and no CURRENT, show current names the harness minted from that file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-show-current-file-'));
  try {
    await mkdir(path.join(root, '.maf'), { recursive: true });
    await writeFile(
      path.join(root, '.maf', 'roles.yaml'),
      JSON.stringify({
        version: 1,
        defaultRole: 'analyst',
        roles: [{ role: 'analyst', systemPrompt: 'Answer the question.\n', allowedTools: ['fs.read'] }],
      }),
      'utf8',
    );

    const fromFile = JSON.parse((await maf(['harness', 'show', 'current', '-d', root])).out.join('\n')) as HarnessConfig;
    assert.equal(fromFile.id, 'legacy-default');
    assert.deepEqual(fromFile.roleSet.roles.map((r) => r.role), ['analyst']);

    // And it is the file's content, not the built-in set: a different set is a different sha.
    const builtin = JSON.parse(
      (await maf(['harness', 'show', 'current', '-d', path.join(root, 'elsewhere')])).out.join('\n'),
    ) as HarnessConfig;
    assert.notEqual(fromFile.sha, builtin.sha);
    assert.equal(await exists(path.join(root, '.maf', 'harnesses')), false, 'no store is created on the way');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
