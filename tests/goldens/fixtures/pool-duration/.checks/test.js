const assert = require('node:assert/strict');
const { parseDuration, formatDuration } = require('./duration');
assert.equal(parseDuration('1h30m'), 90);
assert.equal(parseDuration('2h'), 120);
assert.equal(parseDuration('45m'), 45);
assert.equal(parseDuration('1h5m'), 65);
assert.equal(formatDuration(65), '1h05m');
assert.equal(formatDuration(120), '2h00m');
console.log('ok');
