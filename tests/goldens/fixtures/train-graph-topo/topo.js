const { visit } = require('./visit');
function topo(nodes, edges) {
  const seen = new Set();
  const order = [];
  for (const node of nodes) visit(node, edges, seen, order);
  return order;
}
module.exports = { topo };
