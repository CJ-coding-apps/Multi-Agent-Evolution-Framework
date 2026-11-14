function caesar(text, shift) {
  return text.split('').map((ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code + shift);
    return ch;
  }).join('');
}
module.exports = { caesar };
