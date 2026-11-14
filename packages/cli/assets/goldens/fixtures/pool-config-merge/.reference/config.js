const { defaults } = require('./defaults');
function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlain(value) && isPlain(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}
function load(override) {
  return merge(defaults, override);
}
module.exports = { load };
