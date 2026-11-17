function sortBy(items, keyOf) {
  return items.slice().sort((a, b) => keyOf(a) > keyOf(b));
}
module.exports = { sortBy };
