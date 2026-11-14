function dedupe(items) {
  return [...new Set(items)].sort();
}
module.exports = { dedupe };
