function addMonths(iso, months) {
  const parts = iso.split('-').map(Number);
  const total = parts[0] * 12 + (parts[1] - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(parts[2]).padStart(2, '0');
}
module.exports = { addMonths };
