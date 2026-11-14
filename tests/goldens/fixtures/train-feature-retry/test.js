const assert = require('node:assert/strict');
const { withRetry } = require('./retry');
(async () => {
  const waits = [];
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  }, { attempts: 3, delayMs: 10, backoff: 2, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);

  let seen = 0;
  const errors = [];
  await withRetry(async () => {
    seen++;
    throw new Error('bad' + seen);
  }, { attempts: 4, sleep: async () => {}, shouldRetry: (e) => !e.message.endsWith('3') })
    .catch((e) => errors.push(e.message));
  assert.equal(seen, 3);
  assert.deepEqual(errors, ['bad3']);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
