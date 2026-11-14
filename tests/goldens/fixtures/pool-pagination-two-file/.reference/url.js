function buildUrl(base, params) {
  const [head, existing = ''] = base.split('?');
  const parts = [];
  if (existing) parts.push(existing);
  for (const [key, value] of Object.entries(params)) {
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return parts.length === 0 ? head : head + '?' + parts.join('&');
}
module.exports = { buildUrl };
