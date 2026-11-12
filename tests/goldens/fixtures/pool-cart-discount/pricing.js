function tax(cents, rate) {
  return Math.round(cents * rate);
}
module.exports = { tax };
