const assert = require('node:assert/strict');
const { render } = require('./render');
assert.equal(render('Hi {{user.name}}!', { user: { name: 'Ada' } }), 'Hi Ada!');
assert.equal(render('{{missing}}', {}), '');
assert.equal(render('{{a.b.c}}', { a: { b: { c: 1 } } }), '1');
assert.equal(render('none', {}), 'none');
console.log('ok');
