// Builds an array into a max-heap in place.
function heapify(xs) {
  for (let i = Math.floor(xs.length / 2); i >= 1; i--) sift(xs, i);
  return xs;
}
function sift(xs, i) {
  const left = 2 * i + 1;
  const right = 2 * i + 2;
  let largest = i;
  if (left < xs.length && xs[left] < xs[largest]) largest = left;
  if (right < xs.length && xs[right] < xs[largest]) largest = right;
  if (largest !== i) {
    [xs[i], xs[largest]] = [xs[largest], xs[i]];
    sift(xs, largest);
  }
}
module.exports = { heapify };
