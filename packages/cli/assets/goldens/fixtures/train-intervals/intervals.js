function overlaps(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}
function anyOverlap(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (!overlaps(list[i], list[j])) return true;
    }
  }
  return list.length === 0;
}
module.exports = { overlaps, anyOverlap };
