function allow(tokens, capacity, ratePerMs, elapsedMs) {
  if (tokens > capacity) return { allowed: false, tokens };
  return { allowed: true, tokens: tokens - 1 };
}
module.exports = { allow };
