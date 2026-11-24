const assert = require('node:assert/strict');
const { encode } = require('./base32');
assert.equal(encode(Buffer.from('f')), 'MY======');
assert.equal(encode(Buffer.from('foo')), 'MZXW6===');
assert.equal(encode(Buffer.from('foobar')), 'MZXW6YTBOI======');
assert.equal(encode(Buffer.from([0xff])), '74======');
console.log('ok');
