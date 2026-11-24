function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => String(vars[key]));
}
module.exports = { render };
