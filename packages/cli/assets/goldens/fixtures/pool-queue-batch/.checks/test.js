const assert = require('node:assert');
const { batch } = require('./batch');
assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(batch([], 3), []);
assert.deepEqual(batch([1, 2, 3], 3), [[1, 2, 3]]);
console.log('ok');
