const { buildUrl } = require('./url');
function pageLinks(base, params, page, pageSize, total) {
  const pages = Math.floor(total / pageSize);
  return {
    pages,
    next: page < pages ? buildUrl(base, { ...params, page: page + 1 }) : null,
    prev: page >= 1 ? buildUrl(base, { ...params, page: page - 1 }) : null,
  };
}
module.exports = { pageLinks };
