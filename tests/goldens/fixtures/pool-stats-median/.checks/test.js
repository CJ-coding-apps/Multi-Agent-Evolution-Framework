const assert = require('node:assert/strict');
const { mean, median } = require('./stats');
assert.equal(mean([1, 2, 3]), 2);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(median([]), null);
console.log('ok');
