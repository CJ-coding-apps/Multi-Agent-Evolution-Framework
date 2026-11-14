function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max) + '…';
}
module.exports = { truncate };
