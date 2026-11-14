const assert = require('node:assert/strict');
const { runSequential } = require('./queue');
(async () => {
  const events = [];
  const make = (name, ms) => async () => {
    events.push('start:' + name);
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push('end:' + name);
    return name;
  };
  const out = await runSequential([make('a', 20), make('b', 0)]);
  assert.deepEqual(out, ['a', 'b']);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);

  let started = false;
  await assert.rejects(
    runSequential([async () => { throw new Error('boom'); }, async () => { started = true; }]),
    /boom/,
  );
  assert.equal(started, false);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
