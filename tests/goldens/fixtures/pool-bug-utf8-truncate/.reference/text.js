function truncate(text, max) {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('') + '…';
}
module.exports = { truncate };
