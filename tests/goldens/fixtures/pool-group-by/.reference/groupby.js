function groupBy(xs, keyOf) {
  const out = {};
  for (const x of xs) {
    const key = String(keyOf(x));
    (out[key] ??= []).push(x);
  }
  return out;
}
module.exports = { groupBy };
