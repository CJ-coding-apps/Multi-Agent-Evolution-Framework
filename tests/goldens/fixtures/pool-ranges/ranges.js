function merge(ranges) {
  const out = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
module.exports = { merge };
