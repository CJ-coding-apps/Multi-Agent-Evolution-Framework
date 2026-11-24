const assert = require('node:assert/strict');
const { rot13 } = require('./rot13');
assert.equal(rot13('Hello, World!'), 'Uryyb, Jbeyq!');
assert.equal(rot13('z'), 'm');
assert.equal(rot13('N'), 'A');
assert.equal(rot13(rot13('The Quick Brown Fox 123')), 'The Quick Brown Fox 123');
console.log('ok');
