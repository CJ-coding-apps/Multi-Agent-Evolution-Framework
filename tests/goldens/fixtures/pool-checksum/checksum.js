function checksum(bytes) {
  let c = 0;
  for (const b of bytes) c ^= b;
  return c;
}
module.exports = { checksum };
