function visit(node, edges, seen, order) {
  if (seen.has(node)) return;
  seen.add(node);
  const deps = edges[node] || [];
  for (const dep of deps) visit(dep, edges, seen, order);
  order.push(node);
}
module.exports = { visit };
