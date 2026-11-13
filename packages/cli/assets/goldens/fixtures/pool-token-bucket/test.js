const assert = require('node:assert');
const { allow } = require('./bucket');
assert.deepEqual(allow(0, 2, 0.001, 1000), { allowed: true, tokens: 1 });
assert.deepEqual(allow(0, 2, 0.001, 1000), { allowed: true, tokens: 1 });
assert.deepEqual(allow(2, 2, 0.001, 0), { allowed: false, tokens: 2 });
assert.deepEqual(allow(0, 2, 0.001, 5000), { allowed: true, tokens: 2 });
console.log('ok');
