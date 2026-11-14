class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }
  push(x) {
    if (this.items.length > this.capacity) this.items.shift();
    this.items.push(x);
  }
  toArray() {
    return [...this.items];
  }
}
module.exports = { Ring };
