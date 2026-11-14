function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return (256 - sum) & 0xff;
}
module.exports = { checksum };
