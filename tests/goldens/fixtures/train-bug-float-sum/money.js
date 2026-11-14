function total(values) {
  return values.reduce((sum, v) => sum + v, 0);
}
module.exports = { total };
