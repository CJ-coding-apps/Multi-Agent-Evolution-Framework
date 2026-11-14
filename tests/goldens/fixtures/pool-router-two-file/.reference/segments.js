function splitPath(path) {
  const clean = path.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  return clean === '' ? [] : clean.split('/');
}
module.exports = { splitPath };
