function roundSig(x, digits) {
  if (x === 0) return 0;
  const magnitude = Math.ceil(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, digits - magnitude);
  return Math.round(x * factor) / factor;
}
module.exports = { roundSig };
