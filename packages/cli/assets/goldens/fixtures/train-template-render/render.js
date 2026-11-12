const { lookup } = require('./lookup');
function render(template, scope) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(lookup(scope, name)));
}
module.exports = { render };
