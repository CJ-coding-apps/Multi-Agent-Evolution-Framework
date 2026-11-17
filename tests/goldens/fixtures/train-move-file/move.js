const { resolveTarget } = require('./resolve');
function plan(moves) {
  const out = {};
  for (const from of Object.keys(moves)) out[from] = resolveTarget(moves, from);
  return out;
}
module.exports = { plan };
