// Small helpers for numeric grids.
function transpose(rows) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    out[r] = [];
    for (let c = 0; c < rows[r].length; c++) out[r][c] = rows[c][r];
  }
  return out;
}
module.exports = { transpose };
