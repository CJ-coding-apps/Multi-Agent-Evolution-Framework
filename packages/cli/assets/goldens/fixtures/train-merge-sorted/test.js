const assert = require('node:assert');
const { merge } = require('./merge');
assert.deepEqual(merge([1, 3, 5], [2, 4]), [1, 2, 3, 4, 5]);
assert.deepEqual(merge([1, 1], [1, 2]), [1, 1, 1, 2]);
assert.deepEqual(merge([], [1]), [1]);
console.log('ok');
