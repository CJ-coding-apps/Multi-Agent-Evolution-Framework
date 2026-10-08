import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultRegistry } from '@maf/tools';
import { RoleRegistry, RoleConfigError } from '../RoleRegistry.js';
import { DEFAULT_ROLE_SET } from '../defaults.js';

// ORACLE: WP-2.5 / D-08 — the built-in roles stand in for a roles file only when there is no
// file. `fromYamlOrDefault` answered every read failure with the built-in set, so a roles file
// that was a directory, unreadable, or a symlink whose target had gone was replaced by the
// built-in roles — `coder` with five write tools — and nothing said so.

const BASE_TOOLS = createDefaultRegistry();

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-roles-load-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** `assert.rejects` for a RoleConfigError whose message matches every pattern. */
async function refuses(promise: Promise<unknown>, ...patterns: RegExp[]): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RoleConfigError, `expected a RoleConfigError, got ${String(err)}`);
    for (const pattern of patterns) assert.match(err.message, pattern);
    return true;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('no file at the path: the built-in roles', async () => {
  await withDir(async (dir) => {
    const reg = await RoleRegistry.fromYamlOrDefault(path.join(dir, 'roles.yaml'), dir, BASE_TOOLS);
    assert.deepEqual(reg.names(), DEFAULT_ROLE_SET.roles.map((r) => r.role));
  });
});

test('a roles path that is a directory refuses instead of falling back', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await mkdir(file);
    await refuses(
      RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS),
      new RegExp(escapeRegExp(JSON.stringify(file))),
      /exists but could not be read/,
    );
  });
});

test('a dangling symlink refuses: its name exists, so the role set it named has gone', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await symlink(path.join(dir, 'moved-away.yaml'), file);
    await refuses(RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS), /exists but could not be read/);
  });
});

test('a file that is not valid YAML refuses, naming the file and the line', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, '{\n  "version": 1,\n  "defaultRole": "coder",\n  "roles": [\n}\n', 'utf8');
    await refuses(
      RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS),
      new RegExp(escapeRegExp(JSON.stringify(file))),
      /not valid YAML at line \d+, column \d+/,
    );
  });
});

test('a file that parses but is not a role set refuses, naming the file', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, 'version: 1\ndefaultRole: coder\n', 'utf8');
    await refuses(
      RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS),
      new RegExp(escapeRegExp(JSON.stringify(file))),
      /role-set shape/,
    );
  });
});

test('an empty roles file refuses: it exists, so it is not "no roles file"', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, '# all roles removed\n', 'utf8');
    await refuses(RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS), /role-set shape/);
  });
});

test('a role allowing a tool that does not exist refuses', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, 'version: 1\ndefaultRole: r\nroles:\n  - role: r\n    systemPrompt: x\n    allowedTools: [fs.read, nope.bogus]\n', 'utf8');
    await refuses(RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS), /unknown tool "nope\.bogus"/);
  });
});

test('a role file written as YAML loads', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, [
      '# two roles, block style',
      'version: 1',
      'defaultRole: coder',
      'roles:',
      '  - role: coder',
      '    systemPrompt: be a coder',
      '    allowedTools: [fs.read, fs.write]',
      '    execution: in-process',
      '  - role: tester',
      '    systemPrompt: be a tester',
      '    allowedTools:',
      '      - fs.read',
      '      - test.run',
      '',
    ].join('\n'), 'utf8');
    const reg = await RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS);
    assert.deepEqual(reg.names(), ['coder', 'tester']);
    assert.equal(reg.getDefault().execution, 'in-process');
    assert.deepEqual(reg.list()[1]?.allowedTools, ['fs.read', 'test.run']);
  });
});

test('the JSON form with "#" comment lines, as roles files have always been written, still loads', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'roles.yaml');
    await writeFile(file, [
      '# MAF roles',
      '{',
      '  "version": 1,',
      '  "defaultRole": "coder",',
      '  # a comment line between keys',
      '  "roles": [',
      '\t{ "role": "coder", "systemPrompt": "c # not a comment", "allowedTools": ["fs.read"] }',
      '  ]',
      '}',
      '',
    ].join('\n'), 'utf8');
    const reg = await RoleRegistry.fromYamlOrDefault(file, dir, BASE_TOOLS);
    assert.deepEqual(reg.names(), ['coder']);
    assert.equal(await reg.loadPrompt(reg.getDefault()), 'c # not a comment');
  });
});
