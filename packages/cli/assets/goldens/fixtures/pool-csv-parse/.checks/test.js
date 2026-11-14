const assert = require('node:assert/strict');
const { parse } = require('./csv');
assert.deepEqual(parse('a,b,c'), ['a', 'b', 'c']);
assert.deepEqual(parse('"a,b",c'), ['a,b', 'c']);
assert.deepEqual(parse('"say ""hi""",z'), ['say "hi"', 'z']);
console.log('ok');
