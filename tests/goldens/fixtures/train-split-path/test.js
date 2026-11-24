const assert = require('node:assert');
const { parts } = require('./paths');
assert.deepEqual(parts('a/b/archive.tar.gz'), { name: 'archive.tar', ext: 'gz' });
assert.deepEqual(parts('README'), { name: 'README', ext: '' });
assert.deepEqual(parts('dir/.env'), { name: '.env', ext: '' });
console.log('ok');
