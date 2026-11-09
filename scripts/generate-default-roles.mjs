#!/usr/bin/env node
/**
 * Generates `packages/roles/src/defaultRoleSet.generated.ts` and the committed default harness
 * from this repository's shipped role set — `.maf/roles.yaml` and the prompt files it names
 * (D-61, WP-3.15).
 *
 * One source, two generated copies. The shipped files are what `maf init` writes and what a run in
 * this repository loads; the built-in set is their compiled form, used when a target has no
 * `roles.yaml`, and the default harness is the same role set as a minted, content-addressed config.
 * Before this generator the built-in set was maintained by hand and had drifted from the files in
 * the prompts and in the tester's tools (F2); the harness was minted once by a throwaway script and
 * would have drifted the same way. `packages/cli/src/__tests__/assets.test.ts` already holds
 * `.maf/` and `packages/cli/assets/` byte-identical, so generating from `.maf/` generates from what
 * the package ships.
 *
 *   node scripts/generate-default-roles.mjs           # rewrite the generated files
 *   node scripts/generate-default-roles.mjs --check   # exit 1 if any of them is out of date
 *
 * The roles file is read as the JSON form this repository keeps it in (`roles.yaml` is JSON-in-YAML
 * elsewhere in maf); full-line `#` comments are skipped so the file may carry them. Converting it to
 * block YAML requires replacing this parser with the product's (`RoleRegistry` uses `yaml`).
 *
 * A role's fields are not listed here: every key the file declares is emitted, in file order, except
 * the four this script supplies itself. A field added to the file is therefore hashed without an edit
 * here (MED-3); a value that is not a string, number or boolean stops the generator rather than
 * being dropped silently.
 */
import crypto from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(REPO, '.maf', 'roles.yaml');
const PROMPT_DIR = path.join(REPO, '.maf');
const OUTPUT = path.join(REPO, 'packages', 'roles', 'src', 'defaultRoleSet.generated.ts');
const HARNESS_DIRS = [
  path.join(REPO, '.maf', 'harnesses'),
  path.join(REPO, 'packages', 'cli', 'assets', 'harnesses'),
];
const DEFAULT_HARNESS_RE = /^default-([0-9a-f]{64})\.json$/;
const HARNESS_ID = 'default';

const HEADER = `// GENERATED FILE — do not edit by hand.
//
// It is the shipped role set, compiled in: \`.maf/roles.yaml\` and the prompt files it names,
// which \`maf init\` writes byte for byte from \`packages/cli/assets/\` and which a run in this
// repository loads. The generated module is what a target with no roles file runs (D-61).
//
// Regenerate with: node scripts/generate-default-roles.mjs
// The drift test in one-role-set.test.ts fails when this file and the shipped files disagree.
`;

/** Keys the generator supplies itself; every other key in a role is copied verbatim. */
const GENERATED_KEYS = new Set(['role', 'systemPrompt', 'promptFile', 'allowedTools']);

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

/** The text of one role's prompt: the file's, or the role's own `systemPrompt` when it declares one. */
async function readPrompt(role) {
  if (typeof role.role !== 'string' || role.role === '') fail(`${SOURCE}: every role needs a name`);
  if (role.systemPrompt !== undefined) {
    if (typeof role.systemPrompt !== 'string') {
      fail(`${SOURCE}: role "${role.role}" systemPrompt must be a string`);
    }
    return role.systemPrompt;
  }
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

/**
 * The same rule as `canonicalJson` in `@maf/types` (keys sorted at every depth, array order kept),
 * which is what `computeHarnessSha` hashes. The drift test re-derives the sha with the real code,
 * so a difference here fails the suite rather than going unnoticed.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(sortKeys(value));

/** The role set both outputs are generated from, shaped as `harnessRoleSetFromRegistry` builds it. */
function roleSetOf(roles, prompts) {
  return {
    version: 1,
    defaultRole: roles.defaultRole,
    roles: roles.roles.map((role) => {
      const copy = { ...role, allowedTools: [...role.allowedTools] };
      // Assigned, not spread, so the key lands where `harnessRoleSetFromRegistry` puts it.
      if (copy.systemPrompt === undefined) copy.systemPrompt = prompts.get(role.role);
      return copy;
    }),
  };
}

async function render() {
  const roles = await readRolesFile();
  const prompts = new Map();
  for (const role of roles.roles) {
    if (role === null || typeof role !== 'object' || Array.isArray(role)) {
      fail(`${SOURCE}: every role must be an object`);
    }
    if (!Array.isArray(role.allowedTools) || role.allowedTools.length === 0) {
      fail(`${SOURCE}: role "${role.role}" must list at least one allowed tool`);
    }
    for (const tool of role.allowedTools) {
      if (typeof tool !== 'string' || tool === '') fail(`${SOURCE}: role "${role.role}" has a blank tool id`);
    }
    // Every declared key is copied; nothing is dropped for being unknown here.
    for (const key of Object.keys(role)) {
      if (GENERATED_KEYS.has(key)) continue;
      const value = role[key];
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail(
          `${SOURCE}: role "${role.role}" field ${JSON.stringify(key)} is ` +
          `${Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value}; ` +
          'only a string, number or boolean can be carried into the built-in set',
        );
      }
    }
    prompts.set(role.role, await readPrompt(role));
  }

  const emitted = [];
  for (const role of roles.roles) {
    const lines = [
      '    {',
      `      role: defineRoleName(${lit(role.role)}),`,
    ];
    for (const key of Object.keys(role)) {
      if (GENERATED_KEYS.has(key)) continue;
      lines.push(`      ${key}: ${JSON.stringify(role[key])},`);
    }
    lines.push(`      systemPrompt: ${lit(prompts.get(role.role))},`);
    lines.push('      allowedTools: [');
    for (const tool of role.allowedTools) lines.push(`        makeToolId(${lit(tool)}),`);
    lines.push('      ],');
    lines.push('    },');
    emitted.push(lines.join('\n'));
  }

  const module = [
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

  const base = { id: HARNESS_ID, roleSet: roleSetOf(roles, prompts), processorBundles: [], version: 1 };
  const sha = crypto.createHash('sha256').update(canonicalJson(base), 'utf8').digest('hex');
  const harness = JSON.stringify({ ...base, sha }, null, 2);
  return { module, sha, harness, name: `default-${sha}.json` };
}

/** Stale committed defaults: a `default-<sha>.json` that is not the one this source mints. */
async function staleDefaults(dir, name) {
  return (await readdir(dir).catch(() => []))
    .filter((file) => DEFAULT_HARNESS_RE.test(file) && file !== name);
}

const check = process.argv.includes('--check');
const { module, sha, harness, name } = await render();
const problems = [];

const current = await readFile(OUTPUT, 'utf8').catch(() => undefined);
if (current !== module) problems.push(`${path.relative(REPO, OUTPUT)}`);

for (const dir of HARNESS_DIRS) {
  const text = await readFile(path.join(dir, name), 'utf8').catch(() => undefined);
  if (text !== harness) problems.push(path.relative(REPO, path.join(dir, name)));
  for (const stale of await staleDefaults(dir, name)) {
    problems.push(`${path.relative(REPO, path.join(dir, stale))} (stale: the source mints ${sha.slice(0, 8)})`);
  }
}

if (check) {
  if (problems.length > 0) {
    console.error(
      `generate-default-roles: out of date with ${path.relative(REPO, SOURCE)} and its prompts:\n` +
      problems.map((file) => `  ${file}`).join('\n') +
      '\nRun: node scripts/generate-default-roles.mjs',
    );
    process.exitCode = 1;
  } else {
    console.log(`generate-default-roles: ${path.relative(REPO, OUTPUT)} and ${name} are up to date`);
  }
} else {
  await writeFile(OUTPUT, module, 'utf8');
  for (const dir of HARNESS_DIRS) {
    await writeFile(path.join(dir, name), harness, 'utf8');
    for (const stale of await staleDefaults(dir, name)) {
      const file = path.join(dir, stale);
      const old = JSON.parse(await readFile(file, 'utf8'));
      const { sha: declared, ...rest } = old;
      const rehashed = crypto.createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
      const named = DEFAULT_HARNESS_RE.exec(stale)?.[1];
      if (declared !== rehashed || named !== rehashed) {
        throw new Error(
          `generate-default-roles: refusing to remove ${path.relative(REPO, file)} — it does not hash to its name`,
        );
      }
      await rm(file);
      console.log(`generate-default-roles: removed stale ${path.relative(REPO, file)}`);
    }
  }
  console.log(`generate-default-roles: wrote ${path.relative(REPO, OUTPUT)} and ${name}`);
}
