function parseDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) return 0;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + 'h' + String(m).padStart(2, '0') + 'm';
}
module.exports = { parseDuration, formatDuration };
