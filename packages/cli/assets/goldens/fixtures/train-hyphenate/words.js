function splitWords(text) {
  return text.trim().split(/\s+/).filter((w) => w.length > 0);
}
module.exports = { splitWords };
