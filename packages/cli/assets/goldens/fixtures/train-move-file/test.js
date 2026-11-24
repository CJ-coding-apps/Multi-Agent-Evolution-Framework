const assert = require('node:assert/strict');
const { plan } = require('./move');
assert.deepEqual(plan({ a: 'b', b: 'c' }), { a: 'c', b: 'c' });
assert.deepEqual(plan({ a: 'b' }), { a: 'b' });
assert.deepEqual(plan({}), {});
assert.throws(() => plan({ a: 'b', b: 'a' }), /cycle/);
console.log('ok');
