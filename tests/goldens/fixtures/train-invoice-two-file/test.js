const assert = require('node:assert/strict');
const { total } = require('./invoice');
assert.equal(total([{ price: 1000, qty: 1 }], 0.1, 0.2), 1080);
assert.equal(total([{ price: 333, qty: 3 }], 0.1, 0.2), 1079);
assert.equal(total([{ price: 500, qty: 2 }], 0, 0.1), 1100);
assert.equal(total([{ price: 199, qty: 3 }], 0.15, 0.08), 548);
console.log('ok');
