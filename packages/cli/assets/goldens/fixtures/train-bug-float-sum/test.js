const assert = require('node:assert/strict');
const { total } = require('./money');
assert.equal(total([0.1, 0.2]), 0.3);
assert.equal(total([0.1, 0.2, 0.3]), 0.6);
assert.equal(total([1.005, 2.005]), 3.01);
assert.equal(total([]), 0);
assert.equal(total([19.99, 0.01]), 20);
console.log('ok');
