function walk(doc, segments) {
  let current = doc;
  for (const segment of segments) {
    current = current[segment];
  }
  return current;
}

module.exports = { walk };
