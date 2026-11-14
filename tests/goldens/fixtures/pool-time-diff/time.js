function minutesBetween(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.abs(bh - ah) * 60 + Math.abs(bm - am);
}
module.exports = { minutesBetween };
