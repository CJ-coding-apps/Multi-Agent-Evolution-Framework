const assert = require('node:assert');
const { maxSubarray } = require('./maxSubarray');
assert.equal(maxSubarray([-2, 1, -3, 4, -1, 2, 1, -5, 4]), 6);
assert.equal(maxSubarray([-3, -1, -2]), -1);
assert.equal(maxSubarray([5]), 5);
console.log('ok');
