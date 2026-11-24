function memoize(fn) {
  const cache = new Map();
  return function (...args) {
    if (cache.has(args)) return cache.get(args);
    const value = fn(...args);
    cache.set(args, value);
    return value;
  };
}

module.exports = { memoize };
