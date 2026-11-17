const { walk } = require('./steps');

function resolve(doc, pointer) {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) throw new Error(`invalid pointer: ${JSON.stringify(pointer)}`);
  return walk(doc, pointer.slice(1).split('/'));
}

module.exports = { resolve };
