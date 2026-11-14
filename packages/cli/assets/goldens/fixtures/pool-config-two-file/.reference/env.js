function parseEnv(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else if (/^-?\d+$/.test(String(value))) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}
module.exports = { parseEnv };
