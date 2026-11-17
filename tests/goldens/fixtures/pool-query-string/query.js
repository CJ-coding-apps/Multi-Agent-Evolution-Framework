function parseQuery(q) {
  const out = {};
  for (const pair of q.replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return out;
}
module.exports = { parseQuery };
