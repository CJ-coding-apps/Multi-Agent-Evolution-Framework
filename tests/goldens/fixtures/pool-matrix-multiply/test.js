const assert = require('node:assert');
const { multiply } = require('./multiply');
assert.deepEqual(multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]), [[19, 22], [43, 50]]);
assert.deepEqual(multiply([[1, 0], [0, 1]], [[9, 8], [7, 6]]), [[9, 8], [7, 6]]);
console.log('ok');
