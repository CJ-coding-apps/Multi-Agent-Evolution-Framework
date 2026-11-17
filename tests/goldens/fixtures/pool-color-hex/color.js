const { hexChannels } = require('./channels');

function parseColor(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim().toLowerCase();
  if (value.startsWith('#')) {
    const channels = hexChannels(value.slice(1));
    return channels === null ? null : { r: channels[0], g: channels[1], b: channels[2], a: 1 };
  }
  const match = /^rgba?\(([^)]*)\)$/.exec(value);
  if (match === null) return null;
  const parts = match[1].split(',').map((part) => part.trim());
  const numbers = parts.map((part) => (part === '' ? NaN : Number(part)));
  if (numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  if (numbers.length === 3 || numbers.length === 4) {
    return { r: numbers[0], g: numbers[1], b: numbers[2], a: 1 };
  }
  return null;
}

module.exports = { parseColor };
