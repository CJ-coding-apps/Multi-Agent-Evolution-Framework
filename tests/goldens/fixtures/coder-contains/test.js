const { contains } = require('./contains');
if (contains([1,2,3],1) !== true) { console.error('contains first'); process.exit(1); }
if (contains([1,2,3],3) !== true) { console.error('contains last'); process.exit(1); }
if (contains([1,2,3],4) !== false) { console.error('contains absent'); process.exit(1); }
console.log('ok');
