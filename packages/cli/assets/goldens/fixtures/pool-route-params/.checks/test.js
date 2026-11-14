const assert = require('node:assert/strict');
const { match } = require('./router');
assert.deepEqual(match('/u/:name', '/u/a%20b'), { name: 'a b' });
assert.deepEqual(match('/u/:name', '/u/a%2520b'), { name: 'a%20b' });
assert.equal(match('/u/:name', '/v/a'), null);
console.log('ok');
