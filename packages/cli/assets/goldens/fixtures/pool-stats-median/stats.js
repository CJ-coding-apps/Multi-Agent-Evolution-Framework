function mean(xs) {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}
function sum(xs) {
  return xs.reduce((total, x) => total + x, 0);
}
module.exports = { mean, sum };
