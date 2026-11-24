const assert = require('node:assert');
const { rotate } = require('./rotate');
assert.deepEqual(rotate([1, 2, 3, 4, 5], 2), [4, 5, 1, 2, 3]);
assert.deepEqual(rotate([1, 2, 3], -1), [2, 3, 1]);
assert.deepEqual(rotate([1, 2, 3], 4), [3, 1, 2]);
console.log('ok');
