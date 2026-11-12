const assert = require('node:assert/strict');
const { distance } = require('./distance');
assert.equal(distance('kitten', 'sitting'), 3);
assert.equal(distance('', 'abc'), 3);
assert.equal(distance('abc', ''), 3);
assert.equal(distance('same', 'same'), 0);
console.log('ok');
