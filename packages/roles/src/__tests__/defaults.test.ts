import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { DEFAULT_ROLE_SET, DEFAULT_ROLE_CATALOG } from '../defaults.js';
import { DEFAULT_MAX_TOOL_ITERATIONS } from '../RoleConfig.js';
import { isWriterRole } from '../isWriterRole.js';
import { RoleRegistry } from '../RoleRegistry.js';

test('DEFAULT_ROLE_SET covers coder/tester/security/reviewer/analyst', () => {
  const roles = new Set<string>(DEFAULT_ROLE_SET.roles.map((r) => r.role));
  for (const expected of ['coder', 'tester', 'security', 'reviewer', 'analyst']) {
    assert.ok(roles.has(expected), `missing role ${expected}`);
  }
  assert.equal(DEFAULT_ROLE_SET.defaultRole, 'coder');
});

test('every default role has either systemPrompt or promptFile', () => {
  for (const r of DEFAULT_ROLE_SET.roles) {
    assert.ok(r.systemPrompt || r.promptFile, `role ${r.role} needs a prompt source`);
  }
});

test('catalog mirrors role set length', () => {
  assert.equal(DEFAULT_ROLE_CATALOG.length, DEFAULT_ROLE_SET.roles.length);
});

test('read-only roles cannot write through their allowedTools', () => {
  for (const roleName of ['security', 'reviewer', 'analyst']) {
    const role = DEFAULT_ROLE_SET.roles.find((r) => r.role === roleName)!;
    const writeIds = ['fs.write', 'fs.delete', 'patch.apply', 'git.add', 'git.commit'];
    for (const id of writeIds) {
      assert.ok(
        !role.allowedTools.includes(id as never),
        `role ${roleName} unexpectedly grants ${id}`,
      );
    }
  }
});

test('every default role can expand the summary a Dolt cue names (F8)', () => {
  // Dolt mode's cue says `call lcm.expand("<id>")`. A role without the tool would be handed a
  // pointer it cannot follow, so the cue would be a dead reference rather than a capability.
  const tools = createDefaultRegistry();
  assert.ok(tools.get(makeToolId('lcm.expand')), 'the tool is in the registry every role is cut from');
  for (const role of DEFAULT_ROLE_SET.roles) {
    assert.ok(
      role.allowedTools.includes(makeToolId('lcm.expand')),
      `role "${role.role}" cannot expand the summary its Dolt cue names`,
    );
  }
});

test('the shipped .maf/roles.yaml grants lcm.expand to every role too (F8)', async () => {
  const mafDir = path.resolve(__dirname, '../../../../.maf');
  const roles = await RoleRegistry.fromYamlOrDefault(
    path.join(mafDir, 'roles.yaml'), mafDir, createDefaultRegistry(),
  );
  for (const role of roles.list()) {
    assert.ok(
      role.allowedTools.includes(makeToolId('lcm.expand')),
      `shipped role "${role.role}" cannot expand the summary its Dolt cue names`,
    );
  }
});

test('a prompt\'s "Tools available" line names exactly what its role may call (R13)', () => {
  // The prompt is what the model reads; `allowedTools` is what it may actually call. A prompt that
  // omits a tool teaches the model it cannot do what it can — the reviewer's line omitted
  // `lcm.expand` while its catalogue carried it — and one that names a tool it lacks teaches a call
  // that is refused. Compare the two, for every role whose prompt carries the line.
  const withLine = DEFAULT_ROLE_SET.roles.filter((r) => /Tools available:/.test(r.systemPrompt ?? ''));
  assert.ok(withLine.length >= 3, 'the read-only prompts are here to check');
  for (const role of withLine) {
    // The list ends at the first dot followed by whitespace — not at the dot in `fs.read`.
    const line = /Tools available: ([^\n]+?)\.\s/.exec(role.systemPrompt ?? '')?.[1];
    assert.ok(line, `role "${role.role}" has a malformed Tools-available line`);
    const named = line.split(',').map((s) => s.trim()).sort();
    const allowed = role.allowedTools.map((id) => String(id)).sort();
    assert.deepEqual(
      named, allowed,
      `role "${role.role}" advertises ${named.join(', ')} but may call ${allowed.join(', ')}`,
    );
  }
});

test('no built-in reader is capped below the in-process loop default (F2)', () => {
  // A reader's cap must cover the chain a review or audit actually runs — `git.diff → fs.read →
  // grep → git.log → answer` — or it stops `budget_exhausted` on a task it would otherwise finish.
  // The cap that matters is the in-process loop's, since D-44 moves the built-in readers onto it.
  const readers = DEFAULT_ROLE_SET.roles.filter((r) => !isWriterRole(r));
  assert.ok(readers.length >= 3, 'the built-in readers are here to check');
  for (const role of readers) {
    assert.ok(
      (role.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS) >= DEFAULT_MAX_TOOL_ITERATIONS,
      `reader "${role.role}" caps at ${role.maxToolIterations}, below the loop default ${DEFAULT_MAX_TOOL_ITERATIONS}`,
    );
  }
});

test('the shipped .maf/roles.yaml caps no reader below the loop default either (F2)', async () => {
  // The built-in set above is one source of readers; this repository's own roles file is the one
  // `maf run` actually loads. Its `tester` holds `fs.write` and so is a writer here, which leaves the
  // same three readers the built-ins carry.
  const mafDir = path.resolve(__dirname, '../../../../.maf');
  const roles = await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, createDefaultRegistry());
  const readers = roles.list().filter((r) => !isWriterRole(r));
  assert.ok(readers.length >= 3, 'the shipped readers are here to check');
  for (const role of readers) {
    assert.ok(
      (role.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS) >= DEFAULT_MAX_TOOL_ITERATIONS,
      `reader "${role.role}" caps at ${role.maxToolIterations}, below the loop default ${DEFAULT_MAX_TOOL_ITERATIONS}`,
    );
  }
});
