const assert = require('node:assert/strict');
const { chunk } = require('./chunk');
assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk([], 3), []);
assert.deepEqual(chunk([1, 2], 3), [[1, 2]]);
assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
console.log('ok');
