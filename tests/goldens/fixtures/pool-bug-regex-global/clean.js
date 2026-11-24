const TODO = /TODO/g;
const FIXME = /FIXME/g;

function isClean(text) {
  return !TODO.test(text) && !FIXME.test(text);
}

module.exports = { isClean };
