const assert = require('node:assert/strict');
const { slugify } = require('./slug');
assert.equal(slugify('Hello, World! 2024'), 'hello-world-2024');
assert.equal(slugify('  A  b '), 'a-b');
assert.equal(slugify('--x--'), 'x');
console.log('ok');
