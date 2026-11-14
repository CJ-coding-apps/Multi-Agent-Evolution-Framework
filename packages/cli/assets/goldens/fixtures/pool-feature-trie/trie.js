function createTrie() {
  return {
    insert(word) {},
    has(word) {
      return false;
    },
    wordsWithPrefix(prefix) {
      return [];
    },
  };
}

module.exports = { createTrie };
