function discount(cents, rate) {
  return cents * rate;
}
function tax(cents, rate) {
  return Math.round(cents * rate);
}
module.exports = { discount, tax };
