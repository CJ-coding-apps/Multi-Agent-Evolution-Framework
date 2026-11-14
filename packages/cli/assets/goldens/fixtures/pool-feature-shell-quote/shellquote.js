function quoteArg(arg) {
  return arg;
}

function quoteAll(args) {
  return args.join(' ');
}

module.exports = { quoteArg, quoteAll };
