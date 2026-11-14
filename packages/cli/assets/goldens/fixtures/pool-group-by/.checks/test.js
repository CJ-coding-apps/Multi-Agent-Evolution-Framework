const assert = require('node:assert/strict');
const { groupBy } = require('./groupby');
assert.deepEqual(groupBy([1, 2, 3, 4, 5], (x) => x % 2), { 0: [2, 4], 1: [1, 3, 5] });
assert.deepEqual(groupBy(['a', 'bb', 'c'], (s) => s.length), { 1: ['a', 'c'], 2: ['bb'] });
console.log('ok');
