class Bloom {
  constructor(bytes) {
    this.bits = new Uint8Array(bytes);
  }
  add(s) {
    for (const h of hashes(s)) this.bits[h % (this.bits.length * 8)] = 1;
  }
  has(s) {
    for (const h of hashes(s)) if (this.bits[h % (this.bits.length * 8)] === 0) return false;
    return true;
  }
}
function hashes(s) {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 = (h1 * 31 + code) | 0;
    h2 = (h2 * 17 + code) | 0;
  }
  return [h1, h2];
}
module.exports = { Bloom };
