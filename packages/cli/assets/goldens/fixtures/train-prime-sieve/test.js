const assert = require('node:assert');
const { sieve } = require('./sieve');
assert.deepEqual(sieve(10), [2, 3, 5, 7]);
assert.deepEqual(sieve(7), [2, 3, 5, 7]);
assert.deepEqual(sieve(2), [2]);
console.log('ok');
