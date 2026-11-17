function parseDuration(text) {
  const m = /^(\d+)h(\d+)m$/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}
function formatDuration(minutes) {
  return Math.floor(minutes / 60) + 'h' + (minutes % 60) + 'm';
}
module.exports = { parseDuration, formatDuration };
