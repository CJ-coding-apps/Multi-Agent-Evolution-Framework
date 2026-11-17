const { splitWords } = require('./words');
function hyphenate(text) {
  return splitWords(text).join(' ');
}
module.exports = { hyphenate };
