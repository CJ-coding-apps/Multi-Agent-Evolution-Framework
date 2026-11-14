const assert = require('node:assert/strict');
const { MinHeap } = require('./heap');
const heap = new MinHeap();
for (const x of [5, 1, 3, 2, 4]) heap.push(x);
const out = [];
while (heap.items.length > 0) out.push(heap.pop());
assert.deepEqual(out, [1, 2, 3, 4, 5]);
console.log('ok');
