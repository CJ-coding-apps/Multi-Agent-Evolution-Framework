function distance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 1; r < rows; r++) dp[r][0] = r;
  for (let c = 1; c < cols; c++) dp[0][c] = c;
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      const same = a[r - 1] === b[c - 1] ? 0 : 1;
      dp[r][c] = Math.min(dp[r - 1][c] + 1, dp[r][c - 1] + 1, dp[r - 1][c - 1] + same);
    }
  }
  return dp[rows - 1][cols - 1];
}
module.exports = { distance };
