function compact(xs) {
  const out = xs;
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out.splice(i, 1);
  }
  return out;
}

module.exports = { compact };
