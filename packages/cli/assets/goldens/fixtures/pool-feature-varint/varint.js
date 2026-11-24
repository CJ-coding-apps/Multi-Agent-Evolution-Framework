function encode(n) {
  return Uint8Array.from([0]);
}

function decode(bytes, offset = 0) {
  return { value: 0, bytesRead: 0 };
}

module.exports = { encode, decode };
