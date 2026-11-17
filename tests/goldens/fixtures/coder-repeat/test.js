const { repeat } = require('./repeat');
if (repeat('ab',3) !== 'ababab') { console.error('repeat'); process.exit(1); }
if (repeat('x',0) !== '') { console.error('repeat zero'); process.exit(1); }
console.log('ok');
