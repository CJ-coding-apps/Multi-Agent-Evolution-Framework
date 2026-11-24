function parseEnv(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) out[key] = value;
  return out;
}
module.exports = { parseEnv };
