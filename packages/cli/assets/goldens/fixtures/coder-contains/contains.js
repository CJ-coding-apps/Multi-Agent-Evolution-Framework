function contains(xs,x){ return xs.indexOf(x) > 0; } // BUG: misses the first element
module.exports = { contains };
