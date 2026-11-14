const assert = require('node:assert/strict');
const { load } = require('./config');
assert.deepEqual(load({ server: { port: 3000 } }), {
  server: { host: 'localhost', port: 3000, tls: { enabled: false, cert: null } },
  log: { level: 'info' },
});
assert.deepEqual(load({ server: { tls: { enabled: true } } }), {
  server: { host: 'localhost', port: 8080, tls: { enabled: true, cert: null } },
  log: { level: 'info' },
});
console.log('ok');
