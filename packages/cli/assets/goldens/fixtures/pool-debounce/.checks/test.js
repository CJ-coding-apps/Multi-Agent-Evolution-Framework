const assert = require('node:assert');
const { debounce } = require('./debounce');

// R4-L3: the check drives the debounce with an injected scheduler and a hand-advanced clock, never
// the real one. The fixture used to sleep 60 ms against a 20 ms window, so a loaded host could make
// a correct solution fail; there is no wall-clock wait now, and every edge is exact.
let now = 0;
let nextHandle = 1;
const timers = new Map();
const schedule = (fn, ms) => {
  const handle = nextHandle++;
  timers.set(handle, { at: now + ms, fn });
  return handle;
};
const cancel = (handle) => { timers.delete(handle); };
const advance = (ms) => {
  const target = now + ms;
  for (;;) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (due === undefined) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = target;
};

const calls = [];
const d = debounce(function (...args) { calls.push({ self: this, args }); }, 20, schedule, cancel);

d.call({ id: 1 }, 'a');
d.call({ id: 1 }, 'b');
d.call({ id: 1 }, 'c');
assert.equal(calls.length, 0, 'not called synchronously');
advance(19);
assert.equal(calls.length, 0, 'not called before the window ends');
advance(1);
assert.equal(calls.length, 1, 'called once, after the window');
assert.deepEqual(calls[0].args, ['c'], 'the last call is the one that runs');
assert.deepEqual(calls[0].self, { id: 1 }, 'this is passed through');
assert.equal(timers.size, 0, 'nothing is left scheduled');

// A call after the window fires starts a fresh wait, with its own arguments.
d.call({ id: 2 }, 'd');
advance(20);
assert.equal(calls.length, 2, 'the second window fired once');
assert.deepEqual(calls[1].args, ['d']);

// Calls inside the window restart it: the first call would fire 20 ms later, but the second call
// pushed the window out. At the original deadline nothing fires; it fires 20 ms after the last call.
d.call({ id: 3 }, 'e');
advance(15);
d.call({ id: 3 }, 'f');
advance(4);
assert.equal(calls.length, 2, 'not yet');
advance(1);
assert.equal(calls.length, 2, 'the second call restarted the window: the first deadline passed silently');
assert.equal(timers.size, 1, 'the restarted timer is still pending');
advance(15);
assert.equal(calls.length, 3, 'the restarted window fired 20 ms after the last call');
assert.deepEqual(calls[2].args, ['f']);
assert.deepEqual(calls[2].self, { id: 3 });

console.log('ok');
