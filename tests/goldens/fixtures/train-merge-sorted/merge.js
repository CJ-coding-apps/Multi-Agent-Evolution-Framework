function merge(a, b) {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}
module.exports = { merge };
