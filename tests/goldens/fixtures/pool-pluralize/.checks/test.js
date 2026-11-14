const assert = require('node:assert');
const { pluralize } = require('./plural');
assert.equal(pluralize('cat'), 'cats');
assert.equal(pluralize('day'), 'days');
assert.equal(pluralize('box'), 'boxes');
assert.equal(pluralize('city'), 'cities');
console.log('ok');
