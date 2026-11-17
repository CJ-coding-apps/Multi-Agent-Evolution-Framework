const assert = require('node:assert/strict');
const { truncate } = require('./text');
assert.equal(truncate('abc', 5), 'abc');
assert.equal(truncate('abcd', 3), 'abc…');
assert.equal(truncate('a', 0), '…');
const emoji = '\u{1F600}\u{1F600}\u{1F600}';
assert.equal(truncate(emoji, 2), '\u{1F600}\u{1F600}…');
assert.equal(truncate(emoji, 3), emoji);
console.log('ok');
