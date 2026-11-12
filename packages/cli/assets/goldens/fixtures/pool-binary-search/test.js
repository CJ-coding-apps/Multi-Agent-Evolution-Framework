const assert = require('node:assert/strict');
const { binarySearch } = require('./search');
const xs = [1, 3, 5, 7, 9];
assert.equal(binarySearch(xs, 7), 3);
assert.equal(binarySearch(xs, 1), 0);
assert.equal(binarySearch(xs, 4), -1);
assert.equal(binarySearch([], 1), -1);
assert.equal(binarySearch([2, 2, 2], 2) >= 0, true);
console.log('ok');
