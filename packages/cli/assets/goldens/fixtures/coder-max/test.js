const { max } = require('./max');
if (max(3,9) !== 9) { console.error('max(3,9)'); process.exit(1); }
if (max(-2,-5) !== -2) { console.error('max(-2,-5)'); process.exit(1); }
console.log('ok');
