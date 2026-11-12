function resolveTarget(moves, from) {
  return moves[from] === undefined ? from : moves[from];
}
module.exports = { resolveTarget };
