async function withRetry(fn, options = {}) {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 0;
  const backoff = options.backoff ?? 1;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let delay = delayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      await options.sleep(delay);
      delay *= backoff;
    }
  }
}
module.exports = { withRetry };
