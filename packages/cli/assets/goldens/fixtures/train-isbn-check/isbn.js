function validIsbn10(text) {
  const digits = text.replace(/-/g, '').split('');
  if (digits.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (10 - i);
  return sum % 11 === 0;
}
module.exports = { validIsbn10 };
