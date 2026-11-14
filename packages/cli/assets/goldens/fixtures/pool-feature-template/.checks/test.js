const assert = require('node:assert/strict');
const { render } = require('./template');
assert.equal(render('Hi {{name}}!', { name: 'Ann' }), 'Hi Ann!');
assert.equal(render('Hi {{ name }}!', { name: 'Ann' }), 'Hi Ann!');
assert.equal(render('Hi {{name|guest}}', {}), 'Hi guest');
assert.equal(render('Hi {{name|guest}}', { name: undefined }), 'Hi guest');
assert.equal(render('Hi {{name}}', {}), 'Hi {{name}}');
assert.equal(render('{{a}}{{b}}', { a: '{{b}}', b: '2' }), '{{b}}2');
console.log('ok');
