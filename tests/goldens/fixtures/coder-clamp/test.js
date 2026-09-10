const { clamp } = require('./clamp');
if (clamp(10,0,5)!==5 || clamp(-1,0,5)!==0) { console.error('clamp broken'); process.exit(1); }
console.log('ok');
