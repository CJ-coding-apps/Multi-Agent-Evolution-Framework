function makeHandlers(n) {
  const handlers = [];
  for (var i = 0; i < n; i++) {
    handlers.push(function () {
      return i;
    });
  }
  return handlers;
}

module.exports = { makeHandlers };
