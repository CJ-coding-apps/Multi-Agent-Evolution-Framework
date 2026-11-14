const assert = require('node:assert');
const { checksum } = require('./checksum');
assert.equal(checksum([0xff, 0xff]), 2);
assert.equal(checksum([0x01, 0x02]), 1);
assert.equal(checksum([0x80]), 0x81);
console.log('ok');
