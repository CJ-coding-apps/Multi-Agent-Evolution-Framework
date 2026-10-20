import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolId } from '@maf/types';
import type { CliAdapter, TurnAdapter, AdapterCapabilities } from '@maf/types';
import { RoleRegistry } from '../RoleRegistry.js';
import { DEFAULT_ROLE_SET, DEFAULT_ROLE_CATALOG, getDefaultRoleConfig } from '../defaults.js';
import { defineRoleName } from '../RoleConfig.js';
import type { RoleConfig } from '../RoleConfig.js';
import { isWriterRole, requestedTier, effectiveTier } from '../isWriterRole.js';

// ORACLE: D-43 (a fifth built-in role, `analyst`, that answers a question and changes nothing) and
// D-44 (the built-in readers run in-process, where the policy gate, redaction and attested tool
// calls are). A reader on the cli tier is handed the backend's own file tools — the case F7's
// `unexpected_change` guard exists to catch — and running it in-process is what removes the need
// to catch it. D-01's default (a reader on cli, a writer in-process) is unchanged for user roles.

const CLI_ONLY: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};
const WITH_LOOP: AdapterCapabilities = { ...CLI_ONLY, inProcessLoop: true };

/** A backend with no in-process loop (Gemini's shape). */
const cliOnly = { name: 'cli-only', capabilities: () => CLI_ONLY } as unknown as CliAdapter;
/** A backend that can run the loop (Claude's shape). */
const loopable = {
  name: 'loopable',
  capabilities: () => WITH_LOOP,
  sendTurn: async () => ({ text: '', toolCalls: [] }),
} as unknown as TurnAdapter & CliAdapter;

const ANALYST_TOOLS = ['fs.read', 'fs.list', 'fs.stat', 'grep', 'git.status', 'git.diff', 'git.log'];

function builtin(name: string): RoleConfig {
  const role = getDefaultRoleConfig(defineRoleName(name));
  if (!role) throw new Error(`built-in role "${name}" is missing`);
  return role;
}

test('the default set has five roles, and analyst is the read-only one (D-43)', () => {
  assert.equal(DEFAULT_ROLE_SET.roles.length, 5);
  const analyst = builtin('analyst');
  assert.deepEqual(analyst.allowedTools.map(String), ANALYST_TOOLS);
  assert.equal(isWriterRole(analyst), false, 'it holds no write tool');
  assert.equal('expectsChange' in analyst, false, 'it does not declare an expectation of change');
  assert.equal(
    analyst.description,
    'Read-only. Answers a question about the code, investigates, reports. Makes no change.',
  );
  // `RoleRegistry` validates every role it is handed at construction; a throw here fails the test.
  RoleRegistry.fromSet(DEFAULT_ROLE_SET, '/tmp');
});

test("analyst's prompt carries the same closing line the other two readers carry (F7)", () => {
  const closing =
    "No writes — you hold no write tool, and a change you make to the tree fails this node, its " +
    "diff recorded in the run's attestation.";
  for (const name of ['security', 'reviewer', 'analyst']) {
    assert.ok(builtin(name).systemPrompt?.includes(closing), `${name}'s prompt carries the F7 line`);
  }
});

test('the built-in readers ask for the in-process tier (D-44)', () => {
  for (const name of ['security', 'reviewer', 'analyst']) {
    assert.equal(builtin(name).execution, 'in-process', `${name} is in-process by default`);
    assert.equal(requestedTier(builtin(name)), 'in-process');
  }
});

test("a role with no execution keeps D-01's default — unchanged for user roles", () => {
  const reader: RoleConfig = { role: defineRoleName('auditor'), allowedTools: [makeToolId('fs.read')] };
  const writer: RoleConfig = { role: defineRoleName('bot'), allowedTools: [makeToolId('fs.write')] };
  assert.equal(requestedTier(reader), 'cli', 'a custom reader still defaults to cli');
  assert.equal(requestedTier(writer), 'in-process', 'a custom writer still defaults to in-process');
});

test('the built-in readers still fall back to cli on an adapter without the loop', () => {
  for (const name of ['security', 'reviewer', 'analyst']) {
    assert.equal(effectiveTier(builtin(name), cliOnly), 'cli', `${name} cannot run the loop here`);
    assert.equal(effectiveTier(builtin(name), loopable), 'in-process', `${name} runs in-process here`);
  }
});

test('the default catalog mirrors the set: five rows, each carrying writes and expectsChange', () => {
  assert.deepEqual(
    DEFAULT_ROLE_CATALOG.map((e) => [String(e.role), e.writes, e.expectsChange]),
    [
      ['coder',    true,  true],
      ['tester',   true,  false],
      ['security', false, false],
      ['reviewer', false, false],
      ['analyst',  false, false],
    ],
  );
});
