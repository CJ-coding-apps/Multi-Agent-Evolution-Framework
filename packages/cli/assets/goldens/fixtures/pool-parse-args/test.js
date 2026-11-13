const assert = require('node:assert');
const { parseArgs } = require('./args');
assert.deepEqual(parseArgs(['--name', 'ann', '--verbose']), { name: 'ann', verbose: true });
assert.deepEqual(parseArgs(['--verbose', '--name', 'ann']), { verbose: true, name: 'ann' });
assert.deepEqual(parseArgs(['--count=3']), { count: '3' });
console.log('ok');
