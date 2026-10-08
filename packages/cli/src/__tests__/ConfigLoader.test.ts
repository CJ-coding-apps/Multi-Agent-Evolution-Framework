import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigLoader, DEFAULT_MAF_CONFIG, resolveConfig } from '../config/ConfigLoader.js';

// ORACLE: audit P1 "`.maf/config.yaml`: `ConfigLoader` has no callers; every key in the shipped
// file is ignored" and P2 "prototype-pollution guard on JSON config" (WP-2.5, D-08). The loader
// this replaces tried JSON, then an optional YAML import, and answered every failure with `{}`;
// its `merge` was `Object.assign`, so a `__proto__` key set the merged config's prototype.

/** From `packages/cli/dist/__tests__/` up to the repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

async function withConfig(content: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-config-'));
  const file = path.join(dir, 'config.yaml');
  await writeFile(file, content, 'utf8');
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** `assert.rejects`, with every pattern matched against the one error's message. */
async function rejectsWith(promise: Promise<unknown>, ...patterns: RegExp[]): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, 'an Error is thrown');
    for (const pattern of patterns) assert.match(err.message, pattern);
    return true;
  });
}

async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

function quoted(p: string): RegExp {
  return new RegExp(JSON.stringify(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('reads a YAML config: block style, comments, nested sections', async () => {
  const text = [
    '# run settings',
    'adapter: codex',
    'model: gpt-5',
    'worktree: false',
    'lcm:',
    '  mode: Dolt',
    '  contextThreshold: 0.5',
    '  freshTailCount: 10',
    'dag:',
    '  maxConcurrent: 2',
    '  retry:',
    '    maxAttempts: 3',
    '    backoffMs: 0',
    '    backoffFactor: 1.5',
    '    jitterMs: 0',
    'timeouts:',
    '  planMs: 60000',
    '  securityReviewMs: 300000',
    '',
  ].join('\n');
  await withConfig(text, async (file) => {
    assert.deepEqual(await ConfigLoader.load(file), {
      adapter: 'codex', model: 'gpt-5', worktree: false,
      lcm: { mode: 'Dolt', contextThreshold: 0.5, freshTailCount: 10 },
      dag: { maxConcurrent: 2, retry: { maxAttempts: 3, backoffMs: 0, backoffFactor: 1.5, jitterMs: 0 } },
      timeouts: { planMs: 60000, securityReviewMs: 300000 },
    });
  });
});

test('JSON is YAML: a JSON config still loads', async () => {
  await withConfig('{ "adapter": "gemini", "dag": { "maxConcurrent": 1 } }', async (file) => {
    assert.deepEqual(await ConfigLoader.load(file), { adapter: 'gemini', dag: { maxConcurrent: 1 } });
  });
});

test('a missing file yields the defaults and exactly one warning line naming the path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-config-'));
  try {
    const missing = path.join(dir, 'config.yaml');
    let loaded: unknown;
    const lines = await capturingWarnings(async () => { loaded = await ConfigLoader.load(missing); });
    assert.deepEqual(loaded, {});
    assert.equal(lines.length, 1, `expected one warning, got ${JSON.stringify(lines)}`);
    assert.ok(!(lines[0] ?? '').includes('\n'), 'the warning is a single line');
    assert.match(lines[0] ?? '', quoted(missing));
    assert.deepEqual(resolveConfig({ flags: {}, file: {}, defaults: DEFAULT_MAF_CONFIG }), DEFAULT_MAF_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file that is not YAML throws with the path, the line and the reason', async () => {
  await withConfig('adapter: claude\ndag: [\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), quoted(file), /not valid YAML at line 3, column 1/, /cannot start/);
  });
});

test('a value of the wrong type throws with the path, the line and the reason', async () => {
  await withConfig('adapter: claude\ndag:\n  maxConcurrent: 0\n', async (file) => {
    await rejectsWith(
      ConfigLoader.load(file),
      quoted(file),
      /line 3: dag\.maxConcurrent must be a positive integer; found 0\./,
    );
  });
});

test('every problem in the file is reported, each with its line', async () => {
  const text = ['worktree: "yes"', 'lcm:', '  mode: upward', '  contextThreshold: 1.5', 'timeouts:', '  planMs: -1', ''].join('\n');
  await withConfig(text, async (file) => {
    await rejectsWith(
      ConfigLoader.load(file),
      /line 1: worktree must be true or false; found "yes"\./,
      /line 3: lcm\.mode must be "Upward" or "Dolt"; found "upward"\./,
      /line 4: lcm\.contextThreshold must be a number greater than 0 and at most 1; found 1\.5\./,
      /line 6: timeouts\.planMs must be/,
    );
  });
});

test('an unknown key is an error, at the top level and inside a section', async () => {
  await withConfig('adaptor: claude\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), /line 1: unknown key "adaptor"/, /adapter/);
  });
  await withConfig('dag:\n  retry:\n    maxAttempt: 5\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), /line 3: unknown key "dag\.retry\.maxAttempt"/, /maxAttempts/);
  });
});

test('the circuit section is not accepted: nothing on the run path reads it', async () => {
  // acceptance 3: `circuit` was removed from the file and the schema rather than left unread.
  await withConfig('circuit:\n  maxAttempts: 20\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), /line 1: unknown key "circuit"/);
  });
});

test('a "__proto__" key is refused and cannot reach any prototype', async () => {
  for (const text of [
    '__proto__:\n  worktree: false\n',
    '{ "__proto__": { "worktree": false } }',
    'dag:\n  __proto__:\n    maxConcurrent: 99\n',
    'constructor:\n  prototype:\n    polluted: true\n',
  ]) {
    await withConfig(text, async (file) => {
      await rejectsWith(ConfigLoader.load(file), /unknown key "(dag\.)?(__proto__|constructor)"/);
    });
  }
  assert.equal(({} as Record<string, unknown>)['worktree'], undefined);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('an empty file is refused, with a hint for taking every default on purpose', async () => {
  await withConfig('# nothing set\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), quoted(file), /empty/, /\{\}/);
  });
  await withConfig('{}\n', async (file) => {
    assert.deepEqual(await ConfigLoader.load(file), {});
  });
});

test('a config that is a list, not a mapping, is refused', async () => {
  await withConfig('- adapter: claude\n', async (file) => {
    await rejectsWith(ConfigLoader.load(file), /must be a mapping of settings; found a list/);
  });
});

test('a path that exists but cannot be read throws instead of yielding the defaults', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-config-'));
  try {
    const asDir = path.join(dir, 'config.yaml');
    await mkdir(asDir);
    await rejectsWith(ConfigLoader.load(asDir), quoted(asDir), /exists but could not be read/);

    const dangling = path.join(dir, 'linked.yaml');
    await symlink(path.join(dir, 'gone.yaml'), dangling);
    await rejectsWith(ConfigLoader.load(dangling), /exists but could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shipped .maf/config.yaml validates, and states exactly the built-in defaults', async () => {
  const shipped = path.join(REPO_ROOT, '.maf', 'config.yaml');
  const file = await ConfigLoader.load(shipped);
  assert.deepEqual(resolveConfig({ flags: {}, file, defaults: DEFAULT_MAF_CONFIG }), DEFAULT_MAF_CONFIG);
  // Every section the file carries is one the run reads (acceptance 3).
  assert.deepEqual(Object.keys(file).sort(), ['adapter', 'dag', 'lcm', 'timeouts', 'worktree']);
});
