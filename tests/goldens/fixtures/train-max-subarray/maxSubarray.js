function maxSubarray(nums) {
  let best = 0;
  let cur = 0;
  for (const n of nums) {
    cur = Math.max(0, cur + n);
    best = Math.max(best, cur);
  }
  return best;
}
module.exports = { maxSubarray };
