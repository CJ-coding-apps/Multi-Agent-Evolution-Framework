const assert = require('node:assert');
const { parseQuery } = require('./query');
assert.deepEqual(parseQuery('?a=1&b=2&b=3'), { a: '1', b: ['2', '3'] });
assert.deepEqual(parseQuery('a=1'), { a: '1' });
assert.deepEqual(parseQuery('?q=hello%20world'), { q: 'hello world' });
console.log('ok');
