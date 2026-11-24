const { OPERATORS } = require('./rules');
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (/[0-9]/.test(text[i])) {
      let digits = '';
      while (i < text.length && /[0-9]/.test(text[i])) digits += text[i++];
      tokens.push({ kind: 'number', value: digits });
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    throw new Error('unexpected ' + text[i]);
  }
  return tokens;
}
module.exports = { tokenize };
