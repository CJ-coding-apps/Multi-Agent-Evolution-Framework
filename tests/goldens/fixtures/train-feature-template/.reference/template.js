function render(template, vars) {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*(?:\|([^}]*))?\}\}/g, (m, key, fallback) => {
    const value = vars[key];
    if (value !== undefined) return String(value);
    return fallback === undefined ? m : fallback;
  });
}
module.exports = { render };
