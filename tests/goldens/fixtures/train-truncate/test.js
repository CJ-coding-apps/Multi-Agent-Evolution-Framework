const assert = require('node:assert');
const { truncate } = require('./truncate');
assert.equal(truncate('hello world', 8), 'hello\u2026');
assert.equal(truncate('short', 8), 'short');
assert.equal(truncate('hello world', 5), 'hello\u2026');
console.log('ok');
