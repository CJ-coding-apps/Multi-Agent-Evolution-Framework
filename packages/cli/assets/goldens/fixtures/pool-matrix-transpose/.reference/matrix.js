function transpose(rows) {
  if (rows.length === 0) return [];
  return rows[0].map((_, c) => rows.map((row) => row[c]));
}
module.exports = { transpose };
