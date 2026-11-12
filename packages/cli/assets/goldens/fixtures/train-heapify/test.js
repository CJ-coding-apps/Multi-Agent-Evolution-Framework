const assert = require('node:assert/strict');
const { heapify } = require('./heapify');
function isMaxHeap(xs) {
  for (let i = 0; i < xs.length; i++) {
    for (const c of [2 * i + 1, 2 * i + 2]) if (c < xs.length && xs[c] > xs[i]) return false;
  }
  return true;
}
const a = heapify([3, 1, 4, 1, 5, 9, 2, 6]);
assert.equal(isMaxHeap(a), true);
assert.deepEqual(a.slice().sort((x, y) => x - y), [1, 1, 2, 3, 4, 5, 6, 9]);
console.log('ok');
