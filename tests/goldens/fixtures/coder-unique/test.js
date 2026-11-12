const { unique } = require('./unique');
if (JSON.stringify(unique([1,2,1,3,2])) !== '[1,2,3]') { console.error('unique'); process.exit(1); }
if (JSON.stringify(unique([])) !== '[]') { console.error('unique empty'); process.exit(1); }
console.log('ok');
