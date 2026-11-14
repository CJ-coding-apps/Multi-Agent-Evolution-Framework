const { parseEnv } = require('./env');
function load(defaults, fileConfig, env) {
  return { ...defaults, ...parseEnv(env), ...fileConfig };
}
module.exports = { load };
