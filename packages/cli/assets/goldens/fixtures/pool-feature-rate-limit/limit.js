class SlidingWindow {
  constructor(limit, windowMs, now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  take(key) {
    const list = this.hits.get(key) ?? [];
    list.push(this.now());
    this.hits.set(key, list);
    return true;
  }
}
module.exports = { SlidingWindow };
