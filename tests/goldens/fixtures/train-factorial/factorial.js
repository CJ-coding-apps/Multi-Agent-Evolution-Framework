function factorial(n) {
  let out = 1;
  for (let i = 1; i <= n; i++) out *= i;
  return out;
}
module.exports = { factorial };
