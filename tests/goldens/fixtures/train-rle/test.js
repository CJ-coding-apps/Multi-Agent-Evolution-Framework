const assert = require('node:assert/strict');
const { encode, decode } = require('./rle');
assert.equal(encode('aaabbc'), '3a2b1c');
assert.equal(encode('aaaaaaaaaaaa'), '12a');
assert.equal(decode('3a2b1c'), 'aaabbc');
assert.equal(decode('12a'), 'aaaaaaaaaaaa');
console.log('ok');
