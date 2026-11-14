function total(values) {
  const cents = values.reduce((sum, v) => sum + Math.round(v * 100), 0);
  return cents / 100;
}
module.exports = { total };
