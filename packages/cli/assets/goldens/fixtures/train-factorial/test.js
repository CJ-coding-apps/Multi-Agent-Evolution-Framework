const assert = require('node:assert');
const { factorial } = require('./factorial');
assert.equal(factorial(0), 1);
assert.equal(factorial(5), 120);
assert.throws(() => factorial(-1), /negative/);
console.log('ok');
