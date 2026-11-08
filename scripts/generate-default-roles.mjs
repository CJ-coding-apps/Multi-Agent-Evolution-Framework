#!/usr/bin/env node
/**
 * Generates `packages/roles/src/defaultRoleSet.generated.ts` from this repository's shipped role
 * set — `.maf/roles.yaml` and the prompt files it names (D-61, WP-3.15).
 *
 * One source, one generated copy. The shipped files are what `maf init` writes and what a run in
 * this repository loads; the built-in set is their compiled form, used when a target has no
 * `roles.yaml`. Before this generator the two were maintained by hand and had drifted in the
 * prompts and in the tester's tools (F2). `packages/cli/src/__tests__/assets.test.ts` already
 * holds `.maf/` and `packages/cli/assets/` byte-identical, so generating from `.maf/` generates
 * from what the package ships.
 *
 *   node scripts/generate-default-roles.mjs           # rewrite the generated module
 *   node scripts/generate-default-roles.mjs --check   # exit 1 if it is out of date
 *
 * The roles file is read as the JSON form this repository keeps it in (`roles.yaml` is JSON-in-YAML
 * elsewhere in maf); full-line `#` comments are skipped so the file may carry them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(REPO, '.maf', 'roles.yaml');
const PROMPT_DIR = path.join(REPO, '.maf');
const OUTPUT = path.join(REPO, 'packages', 'roles', 'src', 'defaultRoleSet.generated.ts');

const HEADER = `// GENERATED FILE — do not edit by hand.
//
// It is the shipped role set, compiled in: \`.maf/roles.yaml\` and the prompt files it names,
// which \`maf init\` writes byte for byte from \`packages/cli/assets/\` and which a run in this
// repository loads. The generated module is what a target with no roles file runs (D-61).
//
// Regenerate with: node scripts/generate-default-roles.mjs
// The drift test in defaults.test.ts fails when this file and the shipped files disagree.
`;

/** The fields a role may declare, in the order the generated module writes them. */
const ROLE_FIELDS = [
  'description', 'policyTag', 'model', 'execution', 'expectsChange', 'expectsToolCalls',
  'timeoutMs', 'maxToolIterations', 'tokenBudget',
];

function fail(message) {
  throw new Error(`generate-default-roles: ${message}`);
}

/** `roles.yaml` as this repository keeps it: JSON, optionally with full-line `#` comments. */
async function readRolesFile() {
  const text = await readFile(SOURCE, 'utf8');
  const withoutComments = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  let parsed;
  try {
    parsed = JSON.parse(withoutComments);
  } catch (err) {
    fail(`${SOURCE} is not the JSON form of a role set: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${SOURCE} must hold a role-set object`);
  }
  if (parsed.version !== 1) fail(`${SOURCE}: version must be 1, got ${JSON.stringify(parsed.version)}`);
  if (typeof parsed.defaultRole !== 'string' || parsed.defaultRole === '') {
    fail(`${SOURCE}: defaultRole must be a non-empty string`);
  }
  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) {
    fail(`${SOURCE}: roles must be a non-empty array`);
  }
  return parsed;
}

/** The text of one role's prompt, read from the file the roles file names. */
async function readPrompt(role) {
  if (typeof role.role !== 'string' || role.role === '') fail(`${SOURCE}: every role needs a name`);
  if (typeof role.promptFile !== 'string' || role.promptFile === '') {
    fail(`${SOURCE}: role "${role.role}" must name a promptFile — the prompt is the role's text`);
  }
  const file = path.resolve(PROMPT_DIR, role.promptFile);
  if (file !== PROMPT_DIR && !file.startsWith(PROMPT_DIR + path.sep)) {
    fail(`${SOURCE}: role "${role.role}" names ${JSON.stringify(role.promptFile)}, outside ${PROMPT_DIR}`);
  }
  return readFile(file, 'utf8');
}

/** A string literal that reproduces `text` exactly, independent of line endings or quoting. */
const lit = (text) => JSON.stringify(text);

async function render() {
  const roles = await readRolesFile();
  const emitted = [];

  for (const role of roles.roles) {
    if (role === null || typeof role !== 'object' || Array.isArray(role)) {
      fail(`${SOURCE}: every role must be an object`);
    }
    const prompt = await readPrompt(role);
    if (!Array.isArray(role.allowedTools) || role.allowedTools.length === 0) {
      fail(`${SOURCE}: role "${role.role}" must list at least one allowed tool`);
    }
    const lines = [
      '    {',
      `      role: defineRoleName(${lit(role.role)}),`,
    ];
    for (const field of ROLE_FIELDS) {
      if (role[field] === undefined) continue;
      const value = role[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        lines.push(`      ${field}: ${JSON.stringify(value)},`);
      } else {
        fail(`${SOURCE}: role "${role.role}" field ${field} must be a string, number or boolean`);
      }
    }
    lines.push(`      systemPrompt: ${lit(prompt)},`);
    lines.push('      allowedTools: [');
    for (const tool of role.allowedTools) {
      if (typeof tool !== 'string' || tool === '') fail(`${SOURCE}: role "${role.role}" has a blank tool id`);
      lines.push(`        makeToolId(${lit(tool)}),`);
    }
    lines.push('      ],');
    lines.push('    },');
    emitted.push(lines.join('\n'));
  }

  return [
    HEADER,
    "import { makeToolId } from '@maf/types';",
    "import type { RoleSet } from './RoleConfig.js';",
    "import { defineRoleName } from './RoleConfig.js';",
    '',
    'export const DEFAULT_ROLE_SET_FROM_SHIPPED: RoleSet = {',
    '  version: 1,',
    `  defaultRole: defineRoleName(${lit(roles.defaultRole)}),`,
    '  roles: [',
    emitted.join('\n'),
    '  ],',
    '};',
    '',
  ].join('\n');
}

const check = process.argv.includes('--check');
const text = await render();

if (check) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => undefined);
  if (current !== text) {
    console.error(
      `generate-default-roles: ${path.relative(REPO, OUTPUT)} is out of date with ` +
      `${path.relative(REPO, SOURCE)} and its prompts. Run: node scripts/generate-default-roles.mjs`,
    );
    process.exitCode = 1;
  } else {
    console.log(`generate-default-roles: ${path.relative(REPO, OUTPUT)} is up to date`);
  }
} else {
  await writeFile(OUTPUT, text, 'utf8');
  console.log(`generate-default-roles: wrote ${path.relative(REPO, OUTPUT)}`);
}
