function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + '.' + k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}
module.exports = { flatten };
