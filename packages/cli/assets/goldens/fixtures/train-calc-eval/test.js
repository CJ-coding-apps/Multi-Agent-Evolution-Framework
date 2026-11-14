const assert = require('node:assert');
const { evaluate } = require('./evaluate');
assert.equal(evaluate('2 + 3'), 5);
assert.equal(evaluate('10 - 4'), 6);
assert.equal(evaluate('2 + 3 * 4'), 20);
assert.equal(evaluate('2 * 3 + 4'), 10);
assert.equal(evaluate('8 / 2 / 2'), 2);
console.log('ok');
