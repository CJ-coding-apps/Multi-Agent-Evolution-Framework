const assert = require('node:assert');
const { toDecimal } = require('./binary');
assert.equal(toDecimal('1010'), 10);
assert.equal(toDecimal('0b1010'), 10);
assert.equal(toDecimal('0b11111111'), 255);
console.log('ok');
