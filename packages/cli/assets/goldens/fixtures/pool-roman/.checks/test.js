const assert = require('node:assert/strict');
const { toRoman, fromRoman } = require('./roman');
assert.equal(toRoman(4), 'IV');
assert.equal(toRoman(1994), 'MCMXCIV');
assert.equal(fromRoman('IV'), 4);
assert.equal(fromRoman('MCMXCIV'), 1994);
console.log('ok');
