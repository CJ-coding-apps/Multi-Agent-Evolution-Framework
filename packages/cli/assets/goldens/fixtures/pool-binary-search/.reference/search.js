function binarySearch(xs, target) {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] === target) return mid;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
module.exports = { binarySearch };
