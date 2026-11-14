const assert = require('node:assert');
const { checksum } = require('./checksum');
assert.equal(checksum([0xff, 0xff]), 2);
assert.equal(checksum([0x01, 0x02]), 0xfd);
assert.equal(checksum([0x80]), 0x80);
console.log('ok');
