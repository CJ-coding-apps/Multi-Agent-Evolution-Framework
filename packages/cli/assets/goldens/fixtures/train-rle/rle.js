function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    out += (j - i) + text[i];
    i = j + 1;
  }
  return out;
}
function decode(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 2) out += text[i + 1].repeat(Number(text[i]));
  return out;
}
module.exports = { encode, decode };
