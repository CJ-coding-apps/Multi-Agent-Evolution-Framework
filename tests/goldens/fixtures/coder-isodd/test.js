const { isOdd } = require('./isodd');
if (!isOdd(3) || isOdd(4)) { console.error('isOdd broken'); process.exit(1); }
console.log('ok');
