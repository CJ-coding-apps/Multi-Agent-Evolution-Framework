const TABLE = [[1000, 'M'], [500, 'D'], [100, 'C'], [50, 'L'], [10, 'X'], [5, 'V'], [1, 'I']];
function toRoman(n) {
  let out = '';
  for (const [value, symbol] of TABLE) {
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  }
  return out;
}
function fromRoman(text) {
  const value = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let total = 0;
  for (const ch of text) total += value[ch];
  return total;
}
module.exports = { toRoman, fromRoman };
