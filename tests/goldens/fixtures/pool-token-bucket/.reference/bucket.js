function allow(tokens, capacity, ratePerMs, elapsedMs) {
  const available = Math.min(capacity, tokens + elapsedMs * ratePerMs);
  if (available < 1) return { allowed: false, tokens: available };
  return { allowed: true, tokens: available - 1 };
}
module.exports = { allow };
