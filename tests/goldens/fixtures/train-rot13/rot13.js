function rot13(text) {
  return text.replace(/[a-zA-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 13));
}
module.exports = { rot13 };
