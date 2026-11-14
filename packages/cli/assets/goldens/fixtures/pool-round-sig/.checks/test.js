const assert = require('node:assert');
const { roundSig } = require('./round');
assert.equal(roundSig(1234, 2), 1200);
assert.equal(roundSig(0.001234, 2), 0.0012);
assert.equal(roundSig(99.5, 2), 100);
console.log('ok');
