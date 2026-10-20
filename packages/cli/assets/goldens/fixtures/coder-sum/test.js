const { sum } = require('./sum');
if (sum(2,3) !== 5) { console.error('sum broken'); process.exit(1); }
console.log('ok');
