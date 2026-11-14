const { TRANSITIONS } = require('./transitions');
function run(state, event, context, log = []) {
  const t = TRANSITIONS[state][event];
  const next = [...log, event];
  if (!t) return { state, log: next };
  return { state: t.to, log: next };
}
module.exports = { run };
