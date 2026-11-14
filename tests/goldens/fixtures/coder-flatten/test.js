const { flatten } = require('./flatten');
if (JSON.stringify(flatten([1,[2,3],[4]])) !== '[1,2,3,4]') { console.error('flatten'); process.exit(1); }
if (JSON.stringify(flatten([[]])) !== '[]') { console.error('flatten empty'); process.exit(1); }
console.log('ok');
