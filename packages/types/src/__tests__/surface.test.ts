import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSurface } from '../index.js';
import {
  attachedModelSurface, callModelSurface, modelSurfaceWasSent, sha256Hex, withModelSurface,
} from '../index.js';

// R4-L1/R4-L2: the two things an error can say about a model call besides its message. A surface
// rides on the error itself, so a foreign throw can carry anything under that name — the reader
// must validate it and fall back rather than record a field it cannot vouch for. And a failure can
// have happened before the adapter sent anything, which the record must not report as a thrown turn.

const SURFACE: ModelSurface = {
  systemPromptSha256: sha256Hex('system'),
  promptSha256: sha256Hex('prompt'),
  toolCatalog: '',
  argv: ['claude', '--print'],
};

test('a well-formed surface attached to an error is returned as it is', () => {
  const err = withModelSurface(new Error('failed'), SURFACE);
  assert.deepEqual(attachedModelSurface(err), SURFACE);
  assert.equal(modelSurfaceWasSent(err), true, 'by default, an attached surface is a sent attempt');
  assert.equal('modelSurfaceSent' in err, false, 'a sent attempt says nothing extra');
});

test('R4-L1: a malformed attached surface is ignored, warned about, and the caller falls back', () => {
  const malformed = Object.assign(new Error('failed'), {
    modelSurface: { systemPromptSha256: 42, toolCatalog: '', argv: [] },
  });
  const warnings: string[] = [];
  assert.equal(attachedModelSurface(malformed, (line) => warnings.push(line)), undefined);
  assert.equal(warnings.length, 1, 'a defect in an adapter is reported, not silently dropped');
  assert.match(warnings[0] ?? '', /not a valid model surface/);
  assert.match(warnings[0] ?? '', /fallback/);
  assert.deepEqual(attachedModelSurface(malformed), undefined, 'the warning is optional, the rejection is not');
});

test('R4-L1: an argv that is not a list of strings is malformed too', () => {
  const malformed = Object.assign(new Error('failed'), {
    modelSurface: { systemPromptSha256: 'sys', toolCatalog: '', argv: ['claude', 7] },
  });
  let warned = 0;
  assert.equal(attachedModelSurface(malformed, () => { warned += 1; }), undefined);
  assert.equal(warned, 1);
});

test('R4-L1: an error with no modelSurface is not a warning, just a fallback', () => {
  const warnings: string[] = [];
  assert.equal(attachedModelSurface(new Error('plain'), (line) => warnings.push(line)), undefined);
  assert.deepEqual(warnings, []);
  assert.equal(attachedModelSurface('not an object'), undefined);
  assert.equal(attachedModelSurface(undefined), undefined);
});

test('R4-L2: an unsent call keeps its surface but is marked as never sent', () => {
  const err = withModelSurface(new Error('no model configured'), SURFACE, false);
  assert.deepEqual(attachedModelSurface(err), SURFACE, 'the record still says what it would have sent');
  assert.equal(modelSurfaceWasSent(err), false);
});

test('R4-L2: anything that is not an unsent carrier is treated as sent', () => {
  assert.equal(modelSurfaceWasSent(new Error('plain')), true);
  assert.equal(modelSurfaceWasSent('a string'), true);
  assert.equal(modelSurfaceWasSent(undefined), true);
  assert.equal(modelSurfaceWasSent({ modelSurfaceSent: 'false' }), true, 'only the boolean false counts');
});

test('callModelSurface: an output, when there is one, is digested; when there is none, the field is absent', () => {
  const answered = callModelSurface('system', 'prompt', 'answer');
  assert.equal(answered.outputSha256, sha256Hex('answer'));
  const failed = callModelSurface('system', 'prompt');
  assert.equal('outputSha256' in failed, false, 'no answer, so no digest of one — not the digest of ""');
});
