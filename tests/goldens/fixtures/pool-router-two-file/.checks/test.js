const assert = require('node:assert/strict');
const { match } = require('./router');
assert.deepEqual(match('/users/:id', '/users/a%20b'), { id: 'a b' });
assert.deepEqual(match('/users/:id', '/users/7?x=1#top'), { id: '7' });
assert.deepEqual(match('/users/:id/', '/users/7'), { id: '7' });
assert.equal(match('/users/:id', '/users/7/extra'), null);
assert.equal(match('/users/:id', '/teams/7'), null);
console.log('ok');
