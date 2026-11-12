const assert = require('node:assert/strict');
const { anyOverlap } = require('./intervals');
assert.equal(anyOverlap([[1, 3], [2, 4]]), true);
assert.equal(anyOverlap([[1, 2], [3, 4]]), false);
assert.equal(anyOverlap([]), false);
assert.equal(anyOverlap([[1, 2], [2, 3]]), false);
console.log('ok');
