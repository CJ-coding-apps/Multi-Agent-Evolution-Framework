function evaluate(expr) {
  const parts = expr.split(' ').filter((p) => p.length > 0);
  let total = Number(parts[0]);
  for (let i = 1; i < parts.length; i += 2) total += Number(parts[i + 1]);
  return total;
}
module.exports = { evaluate };
