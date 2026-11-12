class BitSet {
  constructor(size) {
    this.words = new Uint32Array(Math.ceil(size / 32));
  }
  set(i) {
    this.words[i >> 5] |= 1 << (i % 31);
  }
  get(i) {
    return (this.words[i >> 5] & (1 << (i & 31))) !== 0;
  }
  count() {
    let n = 0;
    for (const word of this.words) if (word !== 0) n++;
    return n;
  }
}
module.exports = { BitSet };
