// A small fixed-capacity cache.
class Lru {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    return this.map.get(key);
  }
  set(key, value) {
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const newest = [...this.map.keys()].pop();
      this.map.delete(newest);
    }
  }
}
module.exports = { Lru };
