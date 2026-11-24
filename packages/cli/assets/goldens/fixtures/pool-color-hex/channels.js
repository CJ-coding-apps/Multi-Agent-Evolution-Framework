function hexChannels(hex) {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 3) return hex.split('').map((digit) => parseInt(digit, 16));
  if (hex.length === 6) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return null;
}

module.exports = { hexChannels };
