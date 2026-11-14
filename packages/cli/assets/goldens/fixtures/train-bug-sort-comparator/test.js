const assert = require('node:assert/strict');
const { sortBy } = require('./sort');
assert.deepEqual(sortBy([3, 1, 2], (x) => x), [1, 2, 3]);
assert.deepEqual(
  sortBy([{ k: 2, id: 'a' }, { k: 1, id: 'b' }, { k: 2, id: 'c' }], (x) => x.k).map((x) => x.id),
  ['b', 'a', 'c'],
);
assert.deepEqual(sortBy(['bb', 'a', 'cc'], (s) => s.length), ['a', 'bb', 'cc']);
const input = [3, 1, 2];
sortBy(input, (x) => x);
assert.deepEqual(input, [3, 1, 2]);
console.log('ok');
