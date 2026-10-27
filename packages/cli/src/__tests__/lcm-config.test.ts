import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigLoader, DEFAULT_MAF_CONFIG, resolveConfig } from '../config/ConfigLoader.js';
import { summarizerModelFor } from '../wiring.js';

// ORACLE: D-17 (WP-3.2) — the `lcm` section of config.yaml is read, and the summarization model is
// configurable. `lcm.model` is the model a summarization call uses; absent, the run's `--model`
// applies; absent both, the adapter's own model is used (so the resolved value stays undefined).

async function withConfig(content: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-lcm-config-'));
  const file = path.join(dir, 'config.yaml');
  await writeFile(file, content, 'utf8');
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('reads lcm.model from the config file', async () => {
  await withConfig('lcm:\n  model: summary-model\n', async (file) => {
    const cfg = await ConfigLoader.load(file);
    assert.equal(cfg.lcm?.model, 'summary-model');
  });
});

test('an empty lcm.model is refused by name, not silently dropped', async () => {
  await withConfig('lcm:\n  model: ""\n', async (file) => {
    await assert.rejects(ConfigLoader.load(file), /lcm\.model|non-empty model name/);
  });
});

test('lcm.model resolves to the summarization model; --model alone is the fallback', () => {
  const fromFile = resolveConfig({
    flags: {}, file: { lcm: { model: 'cheap-model' } }, defaults: DEFAULT_MAF_CONFIG,
  });
  assert.equal(fromFile.lcm.model, 'cheap-model');
  assert.equal(summarizerModelFor(fromFile), 'cheap-model');
  assert.equal(fromFile.model, undefined, 'the run model is unchanged by the lcm setting');

  const fromRun = resolveConfig({
    flags: { model: 'run-model' }, file: {}, defaults: DEFAULT_MAF_CONFIG,
  });
  assert.equal(fromRun.lcm.model, undefined);
  assert.equal(summarizerModelFor(fromRun), 'run-model', 'no lcm.model: the run model is used');

  const neither = resolveConfig({ flags: {}, file: {}, defaults: DEFAULT_MAF_CONFIG });
  assert.equal(summarizerModelFor(neither), undefined, 'neither: the adapter decides');
});

test('lcm.model outranks the run model for summarization only', () => {
  const cfg = resolveConfig({
    flags: { model: 'run-model' },
    file: { lcm: { model: 'summary-model' } },
    defaults: DEFAULT_MAF_CONFIG,
  });
  assert.equal(cfg.model, 'run-model');
  assert.equal(summarizerModelFor(cfg), 'summary-model');
});

test('everything the engine is built from comes from the lcm section (F12)', async () => {
  // F12: `buildRunStack` must receive the resolved settings rather than hard-code them. This pins
  // each one at the config seam the stack reads.
  await withConfig(
    'lcm:\n  mode: off\n  operator: agentic-map\n  contextThreshold: 0.5\n  freshTailCount: 8\n  summaryTimeoutMs: 9000\n',
    async (file) => {
      const cfg = await ConfigLoader.load(file);
      assert.equal(cfg.lcm?.mode, 'off', 'mode off is a value, not an unknown key');
      assert.equal(cfg.lcm?.operator, 'agentic-map');
      assert.equal(cfg.lcm?.contextThreshold, 0.5);
      assert.equal(cfg.lcm?.freshTailCount, 8);
      assert.equal(cfg.lcm?.summaryTimeoutMs, 9000);
    },
  );
});

test('defaults name every engine setting; the operator is llm-map (F12/F14)', () => {
  const cfg = resolveConfig({ flags: {}, file: {}, defaults: DEFAULT_MAF_CONFIG });
  assert.equal(cfg.lcm.mode, 'Upward');
  assert.equal(cfg.lcm.operator, 'llm-map');
  assert.equal(cfg.lcm.contextThreshold, 0.75);
  assert.equal(cfg.lcm.freshTailCount, 64);
  assert.equal(cfg.lcm.summaryTimeoutMs, 120_000);
});

test('an unknown operator, mode or timeout is refused by name, not defaulted', async () => {
  const cases: [string, RegExp][] = [
    ['lcm:\n  operator: agentic\n', /lcm\.operator|agentic-map/],
    ['lcm:\n  mode: on\n', /lcm\.mode|"off"/],
    ['lcm:\n  summaryTimeoutMs: 0\n', /lcm\.summaryTimeoutMs|milliseconds/],
  ];
  for (const [content, expected] of cases) {
    await withConfig(content, async (file) => {
      await assert.rejects(ConfigLoader.load(file), expected);
    });
  }
});
