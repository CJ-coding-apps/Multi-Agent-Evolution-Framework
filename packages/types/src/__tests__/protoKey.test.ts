import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOTYPE_KEYS, PrototypeKeyError, refusePrototypeKey } from '../index.js';

// The one reviver every JSON file reader uses (WP-3.9 G5). Pinned here so a reader that imports it
// cannot be the only thing that keeps it working.

test('refusePrototypeKey refuses each prototype key at any depth, and names it', () => {
  for (const key of PROTOTYPE_KEYS) {
    for (const text of [
      `{"${key}": {"polluted": true}}`,
      `{"a": {"b": [{"${key}": 1}]}}`,
      `[{"${key}": ["x"]}]`,
    ]) {
      assert.throws(() => JSON.parse(text, refusePrototypeKey), (err: unknown) => {
        assert.ok(err instanceof PrototypeKeyError);
        assert.equal(err.key, key);
        assert.ok(err.message.includes(key), err.message);
        assert.match(err.message, /names a prototype/);
        return true;
      });
    }
  }
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('refusePrototypeKey leaves an ordinary document alone', () => {
  assert.deepEqual(JSON.parse('{"a":[1,{"b":2}],"c":null}', refusePrototypeKey), { a: [1, { b: 2 }], c: null });
});
