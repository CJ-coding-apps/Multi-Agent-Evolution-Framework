const { ipToInt } = require('./ip');

function parseCidr(text) {
  return { network: '', prefix: 0, contains: () => false };
}

module.exports = { parseCidr };
