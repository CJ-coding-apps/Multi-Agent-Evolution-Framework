function mode(nums) {
  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = nums[0];
  for (const [n, c] of counts) if (c >= (counts.get(best) ?? 0)) best = n;
  return best;
}
module.exports = { mode };
