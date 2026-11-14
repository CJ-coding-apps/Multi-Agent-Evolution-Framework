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
      const right = left + 1;
      let smallest = i;
      if (left < this.items.length && this.items[left] < this.items[smallest]) smallest = left;
      if (right < this.items.length && this.items[right] < this.items[smallest]) smallest = right;
      if (smallest === i) return;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}
module.exports = { MinHeap };
