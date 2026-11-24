const assert = require('node:assert/strict');
const { isAnagram } = require('./anagram');
assert.equal(isAnagram('Listen', 'Silent'), true);
assert.equal(isAnagram('Dormitory', 'Dirty Room'), true);
assert.equal(isAnagram('a', 'b'), false);
assert.equal(isAnagram('abc', 'abcd'), false);
console.log('ok');
