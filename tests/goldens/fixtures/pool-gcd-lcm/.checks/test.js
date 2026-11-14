const assert = require('node:assert');
const { lcm } = require('./lcm');
assert.equal(lcm(4, 6), 12);
assert.equal(lcm(3, 5), 15);
assert.equal(lcm(7, 7), 7);
console.log('ok');
