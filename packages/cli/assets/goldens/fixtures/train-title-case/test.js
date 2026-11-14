const assert = require('node:assert/strict');
const { titleCase } = require('./title');
assert.equal(titleCase('hello world'), 'Hello World');
assert.equal(titleCase('the LORD of the flies'), 'The Lord Of The Flies');
assert.equal(titleCase(''), '');
console.log('ok');
