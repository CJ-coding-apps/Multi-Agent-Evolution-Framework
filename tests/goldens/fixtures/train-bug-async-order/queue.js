async function runSequential(factories) {
  return Promise.all(factories.map((f) => f()));
}
module.exports = { runSequential };
