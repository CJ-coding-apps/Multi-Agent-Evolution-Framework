const assert = require('node:assert/strict');
const { wrap } = require('./wrap');
assert.equal(wrap('the quick brown fox', 10), 'the quick\nbrown fox');
assert.equal(wrap('abcdefghijkl mn', 5), 'abcdefghijkl\nmn');
assert.equal(wrap('one', 10), 'one');
console.log('ok');
