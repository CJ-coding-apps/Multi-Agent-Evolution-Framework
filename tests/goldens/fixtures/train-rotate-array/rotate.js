function rotate(nums, k) {
  const n = nums.length;
  return nums.slice(n - k).concat(nums.slice(0, n - k));
}
module.exports = { rotate };
