const { TRANSITIONS } = require('./transitions');
function run(state, event, context, log = []) {
  if (!Object.hasOwn(TRANSITIONS, state)) throw new Error('unknown state: ' + state);
  const t = TRANSITIONS[state][event];
  if (!t) throw new Error('unknown event: ' + event);
  if (!t.guard(context)) return { state, log: [...log] };
  return { state: t.to, log: [...log, event] };
}
module.exports = { run };
