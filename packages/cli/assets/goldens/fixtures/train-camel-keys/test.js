const assert = require('node:assert/strict');
const { camel, camelKeys } = require('./keys');
assert.equal(camel('first_name'), 'firstName');
assert.equal(camel('a_b_c'), 'aBC');
assert.deepEqual(camelKeys({ first_name: 'Ada', nested_obj: { last_name: 'L' }, list: [{ user_id: 1 }] }), {
  firstName: 'Ada',
  nestedObj: { lastName: 'L' },
  list: [{ userId: 1 }],
});
console.log('ok');
