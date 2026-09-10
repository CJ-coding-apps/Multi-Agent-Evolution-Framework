const fs=require('fs');
function readUserFile(base, name){ return fs.readFileSync(base + '/' + name, 'utf8'); }
module.exports={readUserFile};
