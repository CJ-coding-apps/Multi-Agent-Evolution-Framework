const assert = require('node:assert');
const { minutesBetween } = require('./time');
assert.equal(minutesBetween('09:00', '10:30'), 90);
assert.equal(minutesBetween('23:50', '00:10'), 20);
assert.equal(minutesBetween('10:15', '09:45'), 30);
console.log('ok');
