import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { HarnessStore } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { RoleRegistry, harnessRoleSetFromRegistry } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import { registerHarnessCommand } from '../commands/harness.js';

// ORACLE: S6 (WP-3.15, corrected after HIGH-1) — `maf harness show current` answers the question it
// is asked: which harness a plain run dispatches. There are three states, and each has one answer:
// no CURRENT → the roles file, labelled `[roles file]`; a CURRENT that names `legacy-default` → the
// roles file too, since that CURRENT tracks the file (D-39); any other CURRENT → that harness,
// labelled `[current]`. `show` writes nothing: asking what would run cannot change it.

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
    assert.ok((err[0] as string).includes('[roles file]'), `and says where dispatch comes from: ${err[0]}`);
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

test('show current with CURRENT naming legacy-default reports the roles file as it is now', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-show-current-tracks-'));
  try {
    await mkdir(path.join(root, '.maf'), { recursive: true });
    const rolesPath = path.join(root, '.maf', 'roles.yaml');
    const file = (defaultRole: string) => JSON.stringify({
      version: 1,
      defaultRole,
      roles: [{ role: defaultRole, systemPrompt: 'Answer.\n', allowedTools: ['fs.read'] }],
    });
    await writeFile(rolesPath, file('analyst'), 'utf8');

    const pinned = await maf(['harness', 'set-current', 'legacy-default', '-d', root]);
    assert.equal(pinned.error, undefined, pinned.out.join('\n'));

    const first = await maf(['harness', 'show', 'current', '-d', root]);
    const shown = JSON.parse(first.out.join('\n')) as HarnessConfig;
    assert.equal(shown.id, 'legacy-default');
    assert.deepEqual(shown.roleSet.roles.map((r) => r.role), ['analyst']);
    assert.equal(first.err.length, 1);
    assert.ok((first.err[0] as string).includes('[roles file]'), first.err[0]);

    // The file moves; CURRENT still names legacy-default, and show follows the file, not the snapshot.
    await writeFile(rolesPath, file('auditor'), 'utf8');
    const second = await maf(['harness', 'show', 'current', '-d', root]);
    const after = JSON.parse(second.out.join('\n')) as HarnessConfig;
    assert.deepEqual(after.roleSet.roles.map((r) => r.role), ['auditor'], 'a plain run would dispatch the edit');
    assert.notEqual(after.sha, shown.sha);
    assert.equal((await new HarnessStore(path.join(root, '.maf')).current())?.id, 'legacy-default',
      'and CURRENT itself was not touched by show');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('show current with an operator-pinned CURRENT reports that harness, and the drift notice when the file moves (LOW-R2-3)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-show-current-pinned-'));
  try {
    const mafDir = path.join(root, '.maf');
    await mkdir(mafDir, { recursive: true });
    const rolesPath = path.join(mafDir, 'roles.yaml');
    const file = (prompt: string) => JSON.stringify({
      version: 1,
      defaultRole: 'solo',
      roles: [{ role: 'solo', systemPrompt: prompt, allowedTools: ['fs.read'] }],
    });
    await writeFile(rolesPath, file('Work alone.\n'), 'utf8');

    // Pinned to the file's own content, so there is nothing to report until the file moves.
    const store = new HarnessStore(mafDir);
    const mine = store.mint(await harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(rolesPath, mafDir, createDefaultRegistry()),
    ), 'mine');
    await store.save(mine);
    await store.setCurrent(mine.sha);

    const agreeing = await maf(['harness', 'show', 'current', '-d', root]);
    assert.equal(agreeing.error, undefined);
    assert.equal((JSON.parse(agreeing.out.join('\n')) as HarnessConfig).sha, mine.sha);
    assert.equal(agreeing.err.length, 1, agreeing.err.join('\n'));
    assert.ok((agreeing.err[0] as string).includes('[current]'), agreeing.err[0]);
    assert.ok(!(agreeing.err[0] as string).includes('[roles file]'), agreeing.err[0]);

    // The file moves on: the pinned harness still runs, and show says so in the same one line a run prints.
    await writeFile(rolesPath, file('Work alone, and say why.\n'), 'utf8');
    const drifted = await maf(['harness', 'show', 'current', '-d', root]);
    assert.equal(drifted.err.length, 2, drifted.err.join('\n'));
    assert.ok((drifted.err[0] as string).includes('[current]'), drifted.err[0]);
    const notice = drifted.err[1] as string;
    assert.ok(notice.includes('differs from CURRENT'), notice);
    assert.ok(notice.includes('"mine"') && notice.includes(mine.sha.slice(0, 8)), `names what runs: ${notice}`);
    assert.ok(notice.includes('"legacy-default"'), `and what the file would mint: ${notice}`);
    assert.ok(notice.includes('maf harness set-current legacy-default'), `and the way back: ${notice}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
