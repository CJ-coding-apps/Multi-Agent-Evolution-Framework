function debounce(fn, ms) {
  return function (...args) {
    fn.apply(this, args);
  };
}
module.exports = { debounce };
