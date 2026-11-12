const { tax } = require('./pricing');
function total(items, discountRate, taxRate) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  return subtotal + tax(subtotal, taxRate) - Math.round(subtotal * discountRate);
}
module.exports = { total };
