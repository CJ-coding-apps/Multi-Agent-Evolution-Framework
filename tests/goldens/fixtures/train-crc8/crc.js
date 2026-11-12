function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 7; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) : (crc << 1);
    crc &= 0xff;
  }
  return crc;
}
module.exports = { crc8 };
