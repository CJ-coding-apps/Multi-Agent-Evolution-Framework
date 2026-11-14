function multiply(a, b) {
  const out = a.map((row) => new Array(b[0].length).fill(0));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b[0].length; j++) {
      for (let k = 0; k < b.length; k++) out[i][j] += a[i][k] * b[k][j];
    }
  }
  return out;
}
module.exports = { multiply };
