const assert = require('node:assert');
const { hyphenate } = require('./hyphenate');
assert.equal(hyphenate('a b c'), 'a-b-c');
assert.equal(hyphenate('  one   two  '), 'one-two');
console.log('ok');
