const { tax } = require('./pricing');
function total(items, discountRate, taxRate) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const discounted = subtotal - Math.round(subtotal * discountRate);
  return discounted + tax(discounted, taxRate);
}
module.exports = { total };
