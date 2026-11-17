const { discount, tax } = require('./money');
function total(items, discountRate, taxRate) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  return subtotal + tax(subtotal, taxRate) - discount(subtotal, discountRate);
}
module.exports = { total };
