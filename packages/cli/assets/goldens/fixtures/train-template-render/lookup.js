function lookup(scope, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), scope);
}
module.exports = { lookup };
