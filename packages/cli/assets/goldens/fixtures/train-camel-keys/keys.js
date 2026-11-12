const { walk } = require('./walk');
function camel(s) {
  return s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}
function camelKeys(value) {
  return walk(value, (key) => key);
}
module.exports = { camel, camelKeys };
