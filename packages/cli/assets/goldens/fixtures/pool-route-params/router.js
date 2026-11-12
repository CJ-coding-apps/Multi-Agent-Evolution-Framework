const { decode } = require('./params');
function match(pattern, path) {
  const wanted = pattern.split('/');
  const actual = path.split('/');
  if (wanted.length !== actual.length) return null;
  const out = {};
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i].startsWith(':')) out[wanted[i].slice(1)] = decode(decode(actual[i]));
    else if (wanted[i] !== actual[i]) return null;
  }
  return out;
}
module.exports = { match };
