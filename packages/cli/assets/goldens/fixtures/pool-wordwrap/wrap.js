function wrap(text, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  return lines.join('\n');
}
module.exports = { wrap };
