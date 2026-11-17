function parse(line) {
  return line.split(',').map((cell) => cell.trim());
}
module.exports = { parse };
