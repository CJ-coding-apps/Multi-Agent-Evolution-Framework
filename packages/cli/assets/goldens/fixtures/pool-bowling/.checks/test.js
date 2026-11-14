const assert = require('node:assert');
const { total } = require('./bowling');
assert.equal(total([10, 3, 4]), 24);
assert.equal(total([1, 2, 3, 4]), 10);
assert.equal(total([10, 10, 10, 1, 2]), 67);
console.log('ok');
