async function runSequential(factories) {
  const results = [];
  for (const factory of factories) results.push(await factory());
  return results;
}
module.exports = { runSequential };
