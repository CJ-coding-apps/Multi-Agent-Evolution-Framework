import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@maf/types';
import { makeToolId } from '@maf/types';
import { createDefaultRegistry } from '../index.js';
import { LcmExpandTool } from '../plugins/lcm.js';
import type { LcmExpansion } from '../plugins/lcm.js';

// ORACLE: D-17 mechanism / D-52 choices (WP-3.2 F8). Dolt mode's ghost cue tells the model to call
// `lcm.expand`, so the tool has to exist, be read-only, and return what the cue promises: the
// summary text and the messages it covers. Both are model text from an earlier turn, so both leave
// through `redactCredentials` (F7).

const ctx = {} as ToolContext;

const expansion: LcmExpansion = {
  summary: { content: 'the decision was to retry twice', level: 1 },
  messages: [
    { role: 'user', content: 'we saw AKIAIOSFODNN7EXAMPLE in the log' },
    { role: 'assistant', content: 'noted' },
  ],
};

test('lcm.expand is read-only and has no filesystem surface (F8)', () => {
  const tool = new LcmExpandTool(async () => expansion);
  assert.equal(tool.id, makeToolId('lcm.expand'));
  assert.equal(tool.permissionLevel, 'read');
  assert.deepEqual(tool.declaredPaths(), [], 'the archive is not the tree');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['summaryId']);
  assert.deepEqual(tool.inputSchema.required, ['summaryId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('it returns the summary and every source message it covers, both masked (F7/F8)', async () => {
  const tool = new LcmExpandTool(async () => expansion);
  const out = await tool.execute({ summaryId: ' s1 ' }, ctx);

  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /<summary id="s1" level="1">/);
  assert.match(out.stdout, /the decision was to retry twice/);
  assert.match(out.stdout, /<source-messages count="2">/);
  assert.match(out.stdout, /\[USER\] we saw \[REDACTED:aws-access-key\] in the log/);
  assert.match(out.stdout, /\[ASSISTANT\] noted/);
  assert.doesNotMatch(out.stdout, /AKIAIOSFODNN7EXAMPLE/, 'a credential in the sources is masked too');
  assert.deepEqual(out.metadata, { summaryId: 's1', level: 1, messages: 2 });
});

test('the summary id is passed to the expander trimmed, not as the model typed it', async () => {
  const asked: string[] = [];
  const tool = new LcmExpandTool(async (id) => {
    asked.push(id);
    return expansion;
  });
  await tool.execute({ summaryId: '  abc  ' }, ctx);
  assert.deepEqual(asked, ['abc']);
});

test('an unknown summary fails and names the id; it never answers with an empty success', async () => {
  const tool = new LcmExpandTool(async () => undefined);
  const out = await tool.execute({ summaryId: 'from-another-run' }, ctx);

  assert.notEqual(out.exitCode, 0);
  assert.match(out.stderr, /no summary "from-another-run"/);
  assert.equal(out.stdout, '');
});

test('a registry without an archive still carries the tool and says so truthfully (F8)', async () => {
  // The harness is minted before the run opens its LCM store, so this registry is the one that
  // validates every role allowlist. It must know the id, and the failure must not pretend a
  // summary that exists elsewhere is unknown.
  const tools = createDefaultRegistry();
  assert.ok(tools.get(makeToolId('lcm.expand')), 'the id is in every registry a run builds');

  const out = await tools.get(makeToolId('lcm.expand'))!.execute({ summaryId: 's1' }, ctx);
  assert.notEqual(out.exitCode, 0);
  assert.match(out.stderr, /no context archive/);
});

test('a registry given an expander resolves against it', async () => {
  const tools = createDefaultRegistry({ lcmExpand: async () => expansion });
  const out = await tools.get(makeToolId('lcm.expand'))!.execute({ summaryId: 's1' }, ctx);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /the decision was to retry twice/);
});
