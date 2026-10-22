import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRunId } from '@maf/types';
import { MemoryGraph } from '@maf/memory-graph';
import { ScriptedAdapter } from '@maf/eval-harness';
import { buildRunStack } from '../wiring.js';
import { DEFAULT_MAF_CONFIG } from '../config/ConfigLoader.js';

// ORACLE (M1): a setup that fails after the graph is opened closes it. The reported case is a
// mistyped `--policy` on `goldens`: `buildRunStack` never returns, so nothing could close the
// handle, and the command's own cleanup then failed with ENOTEMPTY — replacing "policy file not
// found" with a filesystem error. This exercises the stack itself, not a command that mocks it.

test('a stack whose policy cannot be resolved closes the graph it opened (M1)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-stack-m1-'));
  // The handle is native state no filesystem check can see reliably: Kùzu lets the same database be
  // reopened while one is open. The close itself is the observable, and the mutation (drop it from
  // the catch) is what makes this test red.
  const realClose = MemoryGraph.prototype.close;
  let closes = 0;
  MemoryGraph.prototype.close = function close(this: MemoryGraph): void {
    closes += 1;
    realClose.call(this);
  };
  try {
    const mafDir = path.join(root, 'state');
    await mkdir(mafDir, { recursive: true });
    await assert.rejects(
      buildRunStack({
        cwd: root, mafDir, policy: { value: 'typo/policy.yaml', typed: true },
        adapter: new ScriptedAdapter(), runId: makeRunId(crypto.randomUUID()), harnessSha: 'a'.repeat(64),
        lcm: DEFAULT_MAF_CONFIG.lcm,
      }),
      /Policy file ".*typo[/\\]policy\.yaml" not found/,
    );
    assert.equal(closes, 1, 'the graph the failed stack opened was closed before the error was rethrown');
    // And the directory it lived in is removable afterwards, as goldens' cleanup needs — in one
    // attempt. A graph whose handles are still open keeps the directory and fails here; retrying
    // would hide exactly the thing this test exists to catch (WP-3.8's lazy setup made the close
    // deterministic, so the retry #52 carried is no longer needed).
    await rm(mafDir, { recursive: true, force: true });
  } finally {
    MemoryGraph.prototype.close = realClose;
    await rm(root, { recursive: true, force: true });
  }
});
