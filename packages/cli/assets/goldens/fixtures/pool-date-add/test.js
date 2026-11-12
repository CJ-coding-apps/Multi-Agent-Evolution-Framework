const assert = require('node:assert/strict');
const { addMonths } = require('./dateadd');
assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
assert.equal(addMonths('2024-03-31', 1), '2024-04-30');
assert.equal(addMonths('2024-01-15', 2), '2024-03-15');
assert.equal(addMonths('2024-11-30', 2), '2025-01-30');
console.log('ok');
