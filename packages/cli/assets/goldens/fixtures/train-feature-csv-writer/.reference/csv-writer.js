function escapeCell(cell) {
  const text = String(cell);
  return /[,"\r\n]/.test(text) ? '"' + text.replace(/\"/g, '""') + '"' : text;
}
function formatRow(cells) {
  return cells.map(escapeCell).join(',');
}
function formatRows(rows) {
  return rows.map(formatRow).join('\r\n');
}
module.exports = { escapeCell, formatRow, formatRows };
