function rowSums(grid) {
  return grid.map((row) => row.reduce((sum, x) => sum + x, 0));
}
module.exports = { rowSums };
