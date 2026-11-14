const assert = require('node:assert/strict');
const { tokenize } = require('./tokenizer');
assert.deepEqual(tokenize('1<=2'), [
  { kind: 'number', value: '1' },
  { kind: 'op', value: '<=' },
  { kind: 'number', value: '2' },
]);
assert.deepEqual(tokenize('1<2'), [
  { kind: 'number', value: '1' },
  { kind: 'op', value: '<' },
  { kind: 'number', value: '2' },
]);
assert.deepEqual(tokenize('1 + 2'), [
  { kind: 'number', value: '1' },
  { kind: 'op', value: '+' },
  { kind: 'number', value: '2' },
]);
console.log('ok');
