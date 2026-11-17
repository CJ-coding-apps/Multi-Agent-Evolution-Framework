const assert = require('node:assert');
const { validIsbn10 } = require('./isbn');
assert.equal(validIsbn10('0306406152'), true);
assert.equal(validIsbn10('080442957X'), true);
assert.equal(validIsbn10('0306406153'), false);
console.log('ok');
