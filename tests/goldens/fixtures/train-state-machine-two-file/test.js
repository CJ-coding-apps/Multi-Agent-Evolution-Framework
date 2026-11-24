const assert = require('node:assert/strict');
const { run } = require('./machine');
assert.deepEqual(run('idle', 'start', { ready: true }), { state: 'running', log: ['start'] });
assert.deepEqual(run('idle', 'start', { ready: false }), { state: 'idle', log: [] });
assert.deepEqual(run('running', 'finish', { errors: 1 }), { state: 'running', log: [] });
assert.deepEqual(run('running', 'finish', { errors: 0 }), { state: 'done', log: ['finish'] });
assert.throws(() => run('idle', 'nope', {}), /nope/);
assert.throws(() => run('mystery', 'start', {}), /mystery/);
console.log('ok');
