const TRANSITIONS = {
  idle: { start: { to: 'running', guard: (ctx) => ctx.ready === true } },
  running: { finish: { to: 'done', guard: (ctx) => ctx.errors === 0 } },
  paused: {},
  done: {},
};
module.exports = { TRANSITIONS };
