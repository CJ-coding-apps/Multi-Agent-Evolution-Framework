const assert = require('node:assert/strict');
const { load } = require('./config');
const defaults = { server: { host: 'localhost', port: 8080, tls: false }, log: { level: 'info' } };
assert.deepEqual(load(defaults, { server: { port: 9000 } }, {}), {
  server: { host: 'localhost', port: 9000, tls: false }, log: { level: 'info' },
});
assert.deepEqual(load(defaults, { server: { port: 9000 } }, { 'server.port': '3001', 'server.tls': 'true' }), {
  server: { host: 'localhost', port: 3001, tls: true }, log: { level: 'info' },
});
assert.deepEqual(load(defaults, {}, { 'log.level': 'debug' }).log, { level: 'debug' });
assert.deepEqual(defaults.server, { host: 'localhost', port: 8080, tls: false });
console.log('ok');
