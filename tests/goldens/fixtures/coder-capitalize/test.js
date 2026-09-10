const { capitalize } = require('./capitalize');
if (capitalize('hello') !== 'Hello') { console.error('capitalize broken'); process.exit(1); }
console.log('ok');
