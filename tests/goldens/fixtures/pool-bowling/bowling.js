function total(rolls) {
  let score = 0;
  for (const r of rolls) score += r;
  return score;
}
module.exports = { total };
