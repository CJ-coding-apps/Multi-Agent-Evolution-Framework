const assert = require('node:assert');
const { parseBool } = require('./parseBool');
assert.equal(parseBool('true'), true);
assert.equal(parseBool('yes'), true);
assert.equal(parseBool('1'), true);
assert.equal(parseBool('no'), false);
assert.throws(() => parseBool('maybe'), /cannot read/);
console.log('ok');
