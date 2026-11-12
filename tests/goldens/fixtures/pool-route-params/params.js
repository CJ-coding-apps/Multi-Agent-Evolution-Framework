function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
module.exports = { decode };
