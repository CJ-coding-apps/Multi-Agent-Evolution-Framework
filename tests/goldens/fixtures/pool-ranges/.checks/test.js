const assert = require('node:assert/strict');
const { merge } = require('./ranges');
assert.deepEqual(merge([[5, 7], [1, 3]]), [[1, 3], [5, 7]]);
assert.deepEqual(merge([[1, 5], [3, 7]]), [[1, 7]]);
assert.deepEqual(merge([[1, 2], [2, 3]]), [[1, 3]]);
const input = [[5, 7], [1, 3]];
merge(input);
assert.deepEqual(input, [[5, 7], [1, 3]]);
console.log('ok');
