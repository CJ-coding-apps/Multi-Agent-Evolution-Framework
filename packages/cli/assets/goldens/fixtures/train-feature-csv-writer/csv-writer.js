function escapeCell(cell) {
  return String(cell);
}
function formatRow(cells) {
  return cells.map(escapeCell).join(',');
}
function formatRows(rows) {
  return rows.map(formatRow).join('\n');
}
module.exports = { escapeCell, formatRow, formatRows };
