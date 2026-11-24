const { pad } = require('./pad');
if (pad('7',3) !== '007') { console.error('pad short'); process.exit(1); }
if (pad('42',3) !== '042') { console.error('pad two'); process.exit(1); }
if (pad('123',3) !== '123') { console.error('pad exact'); process.exit(1); }
console.log('ok');
