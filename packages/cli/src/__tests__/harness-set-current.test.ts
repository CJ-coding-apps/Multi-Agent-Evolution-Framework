import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { HarnessConfigError, HarnessStore } from '@maf/harness-config';
import type { HarnessRoleSet } from '@maf/harness-config';
import { registerHarnessCommand } from '../commands/harness.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { runInit } from '../commands/init.js';
import { collector } from './runFixture.js';

// ORACLE: D-39 (verifier F2 on WP-2.9) — `maf harness set-current` on a legacy-default snapshot
// other than the newest mint is refused, pointing at `--harness <sha>`. Accepting it was a lie:
// CURRENT naming a legacy-default harness tracks the roles file, so the next plain run re-minted
// and moved CURRENT off the snapshot the operator had just chosen.

function roles(prompt: string): HarnessRoleSet {
  return { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: prompt, allowedTools: ['fs.read'] }] };
}

/** `maf <args>` against the harness command alone; the action's error is the rejection. */
async function maf(args: string[]): Promise<string[]> {
  const program = new Command().exitOverride();
  registerHarnessCommand(program);
  const printed: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { printed.push(parts.join(' ')); };
  try {
    await program.parseAsync(args, { from: 'user' });
  } finally {
    console.log = log;
  }
  return printed;
}

test('maf harness set-current refuses an older legacy-default snapshot and names --harness <sha>', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-set-current-'));
  try {
    const store = new HarnessStore(path.join(root, '.maf'));
    const older = await store.adoptLegacy(roles('v1'));
    const newest = await store.adoptLegacy(roles('v2'));

    await assert.rejects(() => maf(['harness', 'set-current', older.sha, '-d', root]), (err: unknown) =>
      err instanceof HarnessConfigError
      && err.message.startsWith(`Harness ${older.sha} is an older legacy-default snapshot`)
      && err.message.includes(`--harness ${older.sha} `));
    assert.equal((await store.current())?.sha, newest.sha, 'CURRENT is not moved by a refused set-current');

    // `legacy-default` by name means the roles file as it is now (D-39), so it is minted here rather
    // than looked up: no roles file in this root, so the built-in set is what a plain run would use.
    const printed = await maf(['harness', 'set-current', 'legacy-default', '-d', root]);
    const current = await store.current();
    assert.equal(current?.id, 'legacy-default');
    assert.equal(printed.length, 1);
    assert.ok((printed[0] as string).includes(`legacy-default (${(current?.sha as string).slice(0, 8)})`), printed[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ORACLE (S6 MED-1). The documented way back — `maf harness set-current legacy-default` — has to
// work in a repository that has only ever run `maf init`. `legacy-default` is never in the store
// (a plain run mints it in memory), so the command used to answer "No harness found for ref".
// It mints the roles-file harness on demand, stores it and points CURRENT at it.

test('maf harness set-current legacy-default works on a freshly initialised repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-set-current-fresh-'));
  try {
    const repo = await createDemoFixture(root);
    await runInit({ dir: repo, out: collector() });
    const store = new HarnessStore(path.join(repo, '.maf'));
    assert.equal(await store.current(), undefined, 'init leaves CURRENT absent');

    const printed = await maf(['harness', 'set-current', 'legacy-default', '-d', repo]);
    const current = await store.current();
    assert.equal(current?.id, 'legacy-default');
    assert.ok((printed[0] as string).includes(current?.sha.slice(0, 8) as string), printed[0]);
    assert.ok(
      await access(path.join(store.dir, `${current?.sha as string}.yaml`)).then(() => true, () => false),
      'the minted harness is stored, so CURRENT can name it',
    );

    // It is the roles file this repository has, not the built-in set: dropping a role from the file
    // changes what CURRENT names when the way back is taken again.
    const rolesPath = path.join(repo, '.maf', 'roles.yaml');
    const parsed = JSON.parse(await readFile(rolesPath, 'utf8')) as { defaultRole: string; roles: Array<{ role: string }> };
    parsed.roles = parsed.roles.filter((r) => r.role !== 'tester');
    if (parsed.defaultRole === 'tester') parsed.defaultRole = parsed.roles[0]?.role as string;
    await writeFile(rolesPath, JSON.stringify(parsed), 'utf8');
    await maf(['harness', 'set-current', 'legacy-default', '-d', repo]);
    const after = await store.current();
    assert.notEqual(after?.sha, current?.sha, 'the edit moved the harness the way back points at');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
