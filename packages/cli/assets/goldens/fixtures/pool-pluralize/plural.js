function pluralize(word) {
  if (word.endsWith('y')) return word.slice(0, -1) + 'ies';
  return word + 's';
}
module.exports = { pluralize };
