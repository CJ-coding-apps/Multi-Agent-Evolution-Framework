import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolId } from '@maf/types';
import { createDefaultRegistry } from '@maf/tools';
import { RoleToolRegistry } from '../RoleToolRegistry.js';

test('getAll filters base tools by allowed set', () => {
  const base = createDefaultRegistry();
  const allowed = [makeToolId('fs.read'), makeToolId('grep')];
  const filtered = new RoleToolRegistry(base, allowed);
  const ids = filtered.getAll().map((t) => t.id);
  assert.deepEqual(ids.sort(), ['fs.read', 'grep'].sort());
});

test('get returns undefined for disallowed tool', () => {
  const base = createDefaultRegistry();
  const filtered = new RoleToolRegistry(base, [makeToolId('fs.read')]);
  assert.equal(filtered.get(makeToolId('fs.write')), undefined);
  assert.ok(filtered.get(makeToolId('fs.read')));
});

test('has reflects both allow set and base availability', () => {
  const base = createDefaultRegistry();
  const filtered = new RoleToolRegistry(base, [makeToolId('fs.read'), makeToolId('imaginary')]);
  assert.equal(filtered.has(makeToolId('fs.read')), true);
  // 'imaginary' is in allow set but not in base — should be false.
  assert.equal(filtered.has(makeToolId('imaginary')), false);
});
