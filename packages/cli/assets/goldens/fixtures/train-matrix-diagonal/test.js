const assert = require('node:assert');
const { diagonalSum } = require('./diagonal');
assert.equal(diagonalSum([[1, 2], [3, 4]]), 5);
assert.equal(diagonalSum([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), 15);
assert.equal(diagonalSum([[7]]), 7);
console.log('ok');
