const assert = require('node:assert/strict');
const { transpose } = require('./matrix');
assert.deepEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);
assert.deepEqual(transpose([[1], [2]]), [[1, 2]]);
assert.deepEqual(transpose([]), []);
console.log('ok');
