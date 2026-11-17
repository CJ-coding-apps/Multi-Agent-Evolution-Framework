const { defaults } = require('./defaults');
function merge(base, override) {
  return { ...base, ...override };
}
function load(override) {
  return merge(defaults, override);
}
module.exports = { load };
