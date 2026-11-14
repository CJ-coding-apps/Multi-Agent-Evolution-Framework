const assert = require('node:assert');
const { caesar } = require('./caesar');
assert.equal(caesar('xyz', 3), 'abc');
assert.equal(caesar('Hello, World!', 3), 'Khoor, Zruog!');
assert.equal(caesar('abc', -1), 'zab');
console.log('ok');
