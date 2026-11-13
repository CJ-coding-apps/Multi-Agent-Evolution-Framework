const { stem } = require('./stem');
function parts(p) {
  const name = stem(p);
  const dot = name.indexOf('.');
  return { name: name.slice(0, dot), ext: name.slice(dot + 1) };
}
module.exports = { parts };
