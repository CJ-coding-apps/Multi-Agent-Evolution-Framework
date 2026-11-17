function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
module.exports = { deepEqual };
