function total(rolls) {
  let score = 0;
  let i = 0;
  for (let frame = 0; frame < 10; frame++) {
    if (rolls[i] === 10) {
      score += 10 + (rolls[i + 1] ?? 0) + (rolls[i + 2] ?? 0);
      i += 1;
    } else if ((rolls[i] ?? 0) + (rolls[i + 1] ?? 0) === 10) {
      score += 10 + (rolls[i + 2] ?? 0);
      i += 2;
    } else {
      score += (rolls[i] ?? 0) + (rolls[i + 1] ?? 0);
      i += 2;
    }
  }
  return score;
}
module.exports = { total };
