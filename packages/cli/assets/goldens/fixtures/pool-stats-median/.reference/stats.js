function mean(xs) {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}
function sum(xs) {
  return xs.reduce((total, x) => total + x, 0);
}
function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
module.exports = { mean, median, sum };
