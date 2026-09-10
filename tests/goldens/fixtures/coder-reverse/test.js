const { reverse } = require('./reverse');
if (reverse('abc') !== 'cba') { console.error('reverse broken'); process.exit(1); }
console.log('ok');
