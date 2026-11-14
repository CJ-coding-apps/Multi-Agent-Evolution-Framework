const assert = require('node:assert');
const { mode } = require('./mode');
assert.equal(mode([1, 2, 2, 3]), 2);
assert.equal(mode([5, 5, 7, 7]), 5);
assert.equal(mode([4]), 4);
console.log('ok');
