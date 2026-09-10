const { fib } = require('./fib');
if (fib(10) !== 55) { console.error('fib broken'); process.exit(1); }
console.log('ok');
