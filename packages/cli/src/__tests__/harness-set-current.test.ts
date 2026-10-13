import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { HarnessConfigError, HarnessStore } from '@maf/harness-config';
import type { HarnessRoleSet } from '@maf/harness-config';
import { registerHarnessCommand } from '../commands/harness.js';

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

    // The newest mint is accepted, by id — `maf harness set-current legacy-default` is the remedy
    // other errors name.
    const printed = await maf(['harness', 'set-current', 'legacy-default', '-d', root]);
    assert.deepEqual(printed, [`[maf] CURRENT → legacy-default (${newest.sha.slice(0, 8)})`]);
    assert.equal((await store.current())?.sha, newest.sha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
