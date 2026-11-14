function parseQuery(q) {
  const out = {};
  for (const pair of q.replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const value = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1));
    if (Object.hasOwn(out, key)) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else out[key] = value;
  }
  return out;
}
module.exports = { parseQuery };
