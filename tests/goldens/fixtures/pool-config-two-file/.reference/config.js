const { parseEnv } = require('./env');
function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlain(value) && isPlain(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}
function unflatten(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts[parts.length - 1]] = value;
  }
  return out;
}
function load(defaults, fileConfig, env) {
  return merge(merge(defaults, fileConfig), unflatten(parseEnv(env)));
}
module.exports = { load };
