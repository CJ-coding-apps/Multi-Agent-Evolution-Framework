function split(text) {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}
function diffLines(before, after) {
  const a = split(before);
  const b = split(after);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: '=', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', line: a[i] }); i++; }
    else { out.push({ op: '+', line: b[j] }); j++; }
  }
  while (i < a.length) out.push({ op: '-', line: a[i++] });
  while (j < b.length) out.push({ op: '+', line: b[j++] });
  return out;
}
module.exports = { diffLines };
