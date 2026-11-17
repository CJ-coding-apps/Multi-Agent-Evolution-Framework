function multiply(a, b) {
  const out = [[0, 0], [0, 0]];
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      for (let k = 0; k < 2; k++) out[i][j] += a[i][k] * b[j][k];
  return out;
}
module.exports = { multiply };
