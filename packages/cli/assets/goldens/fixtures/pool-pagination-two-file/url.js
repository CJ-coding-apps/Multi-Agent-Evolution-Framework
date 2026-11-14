function buildUrl(base, params) {
  const qs = Object.entries(params).map(([k, v]) => k + '=' + v).join('&');
  return base + '?' + qs;
}
module.exports = { buildUrl };
