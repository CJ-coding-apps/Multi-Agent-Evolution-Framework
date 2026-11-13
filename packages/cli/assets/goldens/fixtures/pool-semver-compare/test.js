const assert = require('node:assert');
const { compareSemver } = require('./semver');
assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
assert.equal(compareSemver('1.2.10', '1.2.9'), 1);
console.log('ok');
