const assert = require('node:assert/strict');
const { prefixSums } = require('./prefix');
assert.deepEqual(prefixSums([1, 2, 3]), [1, 3, 6]);
assert.deepEqual(prefixSums([]), []);
assert.deepEqual(prefixSums([5]), [5]);
console.log('ok');
