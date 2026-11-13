const assert = require('node:assert');
const { debounce } = require('./debounce');
let calls = 0;
const d = debounce(() => { calls++; }, 20);
d(); d(); d();
assert.equal(calls, 0, 'not called synchronously');
setTimeout(() => {
  assert.equal(calls, 1, 'called once, after the window');
  console.log('ok');
}, 60);
