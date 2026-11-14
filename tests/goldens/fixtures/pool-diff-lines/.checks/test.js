const assert = require('node:assert/strict');
const { diffLines } = require('./diff');
assert.deepEqual(diffLines('a\nb\nc\n', 'a\nc\nd\n'), [
  { op: '=', line: 'a' },
  { op: '-', line: 'b' },
  { op: '=', line: 'c' },
  { op: '+', line: 'd' },
]);
assert.deepEqual(diffLines('x', 'x'), [{ op: '=', line: 'x' }]);
assert.deepEqual(diffLines('', 'y'), [{ op: '+', line: 'y' }]);
console.log('ok');
