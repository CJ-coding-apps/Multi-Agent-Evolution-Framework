function toMinutes(text) {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}
function minutesBetween(a, b) {
  const diff = Math.abs(toMinutes(a) - toMinutes(b));
  return Math.min(diff, 1440 - diff);
}
module.exports = { minutesBetween };
