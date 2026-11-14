function walk(value, fn) {
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[fn(key)] = walk(v, fn);
    return out;
  }
  return value;
}
module.exports = { walk };
