const assert = require('node:assert/strict');
const { countWords } = require('./words');
assert.deepEqual(countWords('the cat and the hat'), { the: 2, cat: 1, and: 1, hat: 1 });
assert.deepEqual(countWords(''), {});
assert.deepEqual(countWords('  a   b   a '), { a: 2, b: 1 });
console.log('ok');
