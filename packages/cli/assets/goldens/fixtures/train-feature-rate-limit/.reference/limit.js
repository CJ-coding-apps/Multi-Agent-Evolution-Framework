class SlidingWindow {
  constructor(limit, windowMs, now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  take(key) {
    const at = this.now();
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(at);
    this.hits.set(key, list);
    return true;
  }
}
module.exports = { SlidingWindow };
