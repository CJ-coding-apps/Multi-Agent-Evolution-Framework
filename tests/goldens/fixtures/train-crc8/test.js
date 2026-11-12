const assert = require('node:assert/strict');
const { crc8 } = require('./crc');
assert.equal(crc8(Buffer.from('123456789')), 0xf4);
assert.equal(crc8(Buffer.from('')), 0x00);
assert.equal(crc8(Buffer.from([0x00])), 0x00);
console.log('ok');
