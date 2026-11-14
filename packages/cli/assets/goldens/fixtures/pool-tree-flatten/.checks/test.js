const assert = require('node:assert');
const { flatten } = require('./flatten-keys');
assert.deepEqual(flatten({ a: 1, b: { c: 2, d: { e: 3 } } }), { a: 1, 'b.c': 2, 'b.d.e': 3 });
assert.deepEqual(flatten({ a: { b: 1 } }), { 'a.b': 1 });
console.log('ok');
