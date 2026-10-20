import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessConfigError } from '@maf/harness-config';
import type { HarnessRoleSet } from '@maf/harness-config';
import { roleSetFromHarness } from '../harnessBridge.js';

// R6/M19: `roleSetFromHarness` is the only guard on the `expectsToolCalls` shape for a *stored* harness.
// A minted or imported harness file's role entries reach the dispatcher through here, never through
// `isRoleSet` — which validates a hand-written roles.yaml (M19b), not a harness. Removing the bridge's
// check would let a truthy non-boolean reach the dispatcher as `expectsToolCalls`, so this one test pins
// that the bridge still refuses it. (M19 survived round 1 because this check was untested.)

test('R6: roleSetFromHarness refuses a non-boolean expectsToolCalls (the stored-harness guard)', () => {
  const roleSet = {
    version: 1,
    defaultRole: 'analyst',
    // `'yes'` is deliberately not a boolean — the field a stored harness could carry after a bad edit.
    roles: [{ role: 'analyst', allowedTools: ['fs.read'], expectsToolCalls: 'yes' }],
  } as unknown as HarnessRoleSet;
  assert.throws(
    () => roleSetFromHarness(roleSet),
    (err: unknown) => err instanceof HarnessConfigError
      && /expectsToolCalls/.test(err.message) && /boolean/.test(err.message),
  );
});
