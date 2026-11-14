function debounce(fn, ms, schedule = setTimeout, cancel = clearTimeout) {
  let handle;
  return function (...args) {
    if (handle !== undefined) cancel(handle);
    handle = schedule(() => {
      handle = undefined;
      fn.apply(this, args);
    }, ms);
  };
}
module.exports = { debounce };
