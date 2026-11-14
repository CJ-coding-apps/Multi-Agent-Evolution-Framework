function discount(cents, rate) {
  return Math.round(cents * rate);
}
function tax(cents, rate) {
  return Math.round(cents * rate);
}
module.exports = { discount, tax };
