const assert = require('node:assert/strict');
const { rowSums, diagonalSum } = require('./grid');
assert.deepEqual(rowSums([[1, 2], [3, 4]]), [3, 7]);
assert.equal(diagonalSum([[1, 2], [3, 4]]), 5);
assert.equal(diagonalSum([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), 15);
assert.equal(diagonalSum([]), 0);
console.log('ok');
