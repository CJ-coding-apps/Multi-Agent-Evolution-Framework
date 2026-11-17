const assert = require('node:assert');
const { dedupe } = require('./dedupe');
assert.deepEqual(dedupe(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
assert.deepEqual(dedupe([3, 1, 3]), [3, 1]);
assert.deepEqual(dedupe([]), []);
console.log('ok');
