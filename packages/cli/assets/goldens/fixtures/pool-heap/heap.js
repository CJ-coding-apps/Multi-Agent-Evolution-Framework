// A binary min-heap of numbers.
class MinHeap {
  constructor() {
    this.items = [];
  }
  push(x) {
    this.items.push(x);
    this.up(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }
  up(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent] <= this.items[i]) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  down(i) {
    for (;;) {
      const left = i * 2 + 1;
      if (left >= this.items.length) return;
      if (this.items[left] < this.items[i]) {
        [this.items[i], this.items[left]] = [this.items[left], this.items[i]];
        i = left;
      } else return;
    }
  }
}
module.exports = { MinHeap };
