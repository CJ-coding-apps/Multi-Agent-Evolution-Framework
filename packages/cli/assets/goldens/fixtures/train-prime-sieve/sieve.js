function sieve(n) {
  const composite = new Array(n).fill(false);
  for (let i = 2; i * i < n; i++) {
    if (composite[i]) continue;
    for (let j = i * i; j < n; j += i) composite[j] = true;
  }
  return composite.map((c, i) => (c ? 0 : i)).filter((x) => x >= 2);
}
module.exports = { sieve };
