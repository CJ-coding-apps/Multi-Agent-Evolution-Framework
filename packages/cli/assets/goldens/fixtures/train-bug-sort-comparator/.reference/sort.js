function sortBy(items, keyOf) {
  return items.slice().sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
module.exports = { sortBy };
