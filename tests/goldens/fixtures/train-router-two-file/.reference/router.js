const { splitPath } = require('./segments');
function match(pattern, path) {
  const wanted = splitPath(pattern);
  const actual = splitPath(path);
  if (wanted.length !== actual.length) return null;
  const out = {};
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i].startsWith(':')) out[wanted[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (wanted[i] !== actual[i]) return null;
  }
  return out;
}
module.exports = { match };
