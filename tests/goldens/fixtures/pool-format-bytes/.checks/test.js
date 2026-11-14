const assert = require('node:assert/strict');
const { formatBytes } = require('./bytes');
assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(1023), '1023 B');
assert.equal(formatBytes(1024), '1.0 KB');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(1048576), '1.0 MB');
assert.equal(formatBytes(1073741824), '1.0 GB');
console.log('ok');
