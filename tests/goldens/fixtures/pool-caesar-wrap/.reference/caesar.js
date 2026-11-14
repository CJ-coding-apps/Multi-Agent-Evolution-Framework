function caesar(text, shift) {
  return text.split('').map((ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : code >= 97 && code <= 122 ? 97 : null;
    if (base === null) return ch;
    return String.fromCharCode(((code - base + shift) % 26 + 26) % 26 + base);
  }).join('');
}
module.exports = { caesar };
