const assert = require('node:assert/strict');
const { zip } = require('./zip');
assert.deepEqual(zip([1, 2, 3], ['a', 'b']), [[1, 'a'], [2, 'b']]);
assert.deepEqual(zip([], []), []);
assert.deepEqual(zip(['x'], [1, 2]), [['x', 1]]);
console.log('ok');
