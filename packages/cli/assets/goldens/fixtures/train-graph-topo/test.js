const assert = require('node:assert/strict');
const { topo } = require('./topo');
assert.deepEqual(topo(['a', 'b', 'c'], { a: ['b'], b: ['c'] }), ['c', 'b', 'a']);
assert.deepEqual(topo(['x'], {}), ['x']);
assert.throws(() => topo(['a'], { a: ['a'] }), /cycle/);
assert.throws(() => topo(['a', 'b'], { a: ['b'], b: ['a'] }), /cycle/);
console.log('ok');
