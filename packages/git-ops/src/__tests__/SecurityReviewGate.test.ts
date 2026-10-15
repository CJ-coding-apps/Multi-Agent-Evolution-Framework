import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecurityOutput } from '../SecurityReviewGate.js';

test('parseSecurityOutput extracts JSON from fenced block', () => {
  const raw = `Here is my audit:

\`\`\`json
{
  "findings": [
    { "severity": "high", "category": "SQLi", "file": "src/db.ts", "line": 42, "rationale": "concat", "remediation": "params" }
  ],
  "summary": "one issue",
  "passed": false
}
\`\`\``;
  const res = parseSecurityOutput(raw);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0]?.severity, 'high');
  assert.equal(res.findings[0]?.file, 'src/db.ts');
  assert.equal(res.passed, false);
});

test('parseSecurityOutput accepts raw JSON object', () => {
  const raw = JSON.stringify({
    findings: [],
    summary: 'looks clean',
    passed: true,
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.findings.length, 0);
  assert.equal(res.passed, true);
});

test('parseSecurityOutput defaults passed=false on parse failure', () => {
  const res = parseSecurityOutput('not json at all, just words');
  assert.equal(res.passed, false);
  assert.match(res.summary, /Could not parse/);
});

test('parseSecurityOutput derives passed from severities when not provided', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'medium', category: 'x', file: 'a.ts', rationale: '', remediation: '' },
      { severity: 'low',    category: 'y', file: 'b.ts', rationale: '', remediation: '' },
    ],
    summary: 'noise only',
  });
  const res = parseSecurityOutput(raw);
  // No critical/high → passed should be true
  assert.equal(res.passed, true);
  assert.equal(res.findings.length, 2);
});

test('parseSecurityOutput derives passed=false when critical present and not explicit', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'critical', category: 'cmdi', file: 'a.ts', rationale: '', remediation: '' },
    ],
    summary: 'critical present',
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, false);
});

test('parseSecurityOutput drops malformed findings entries', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'high', category: 'good', file: 'a.ts', rationale: '', remediation: '' },
      { severity: 'bogus', category: 'bad-sev', file: 'x.ts' },
      { severity: 'medium', file: 'no-category.ts' },
      { severity: 'low', category: 'no-file' },
      'not even an object',
      null,
    ],
    summary: '',
    passed: false,
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0]?.category, 'good');
});

// ORACLE: D-07 — `passed` comes from the severities alone. The model's boolean used to win, so a
// review that reported its own critical finding and said `passed: true` let the diff through.

test('a critical finding blocks even when the model says passed: true', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'critical', category: 'cmdi', file: 'a.ts', rationale: 'exec(input)', remediation: 'execFile' },
    ],
    summary: 'one critical, but I think it is fine',
    passed: true,
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, false);
  assert.equal(res.findings.length, 1);
});

test('a high finding blocks even when the model says passed: true', () => {
  const raw = JSON.stringify({
    findings: [{ severity: 'high', category: 'sqli', file: 'db.ts', rationale: '', remediation: '' }],
    summary: '',
    passed: true,
  });
  assert.equal(parseSecurityOutput(raw).passed, false);
});

test('a critical finding with no category or file still blocks, and is kept', () => {
  // Dropping a malformed entry used to be harmless because the boolean backstopped it; now that
  // the boolean is ignored, dropping a blocking entry would pass the diff.
  const raw = JSON.stringify({ findings: [{ severity: 'critical' }], summary: 'rce', passed: true });
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, false);
  assert.equal(res.findings.length, 1, 'the finding is recorded, not silently discarded');
  assert.equal(res.findings[0]?.severity, 'critical');
});

test('no findings is a pass even when the model says passed: false', () => {
  const raw = JSON.stringify({ findings: [], summary: 'nothing found, but failing anyway', passed: false });
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, true);
  assert.equal(res.findings.length, 0);
});

test('only non-blocking findings is a pass even when the model says passed: false', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'medium', category: 'x', file: 'a.ts', rationale: '', remediation: '' },
      { severity: 'info',   category: 'y', file: 'b.ts', rationale: '', remediation: '' },
    ],
    summary: '',
    passed: false,
  });
  assert.equal(parseSecurityOutput(raw).passed, true);
});

test('a finding whose severity cannot be read fails closed', () => {
  // It may have been critical; there is no severity to derive a pass from.
  const raw = JSON.stringify({
    findings: [{ severity: 'severe', category: 'x', file: 'a.ts', rationale: '', remediation: '' }],
    summary: 'looks bad',
    passed: true,
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, false);
  assert.match(res.summary, /looks bad/, 'the model summary is kept');
  assert.match(res.summary, /no recognisable severity/, 'and the reason for the refusal is added');
});

test('output with no findings array fails closed, whatever the boolean says', () => {
  for (const body of [{ summary: 'clean', passed: true }, { findings: 'none', passed: true }]) {
    const res = parseSecurityOutput(JSON.stringify(body));
    assert.equal(res.passed, false, `${JSON.stringify(body)} must not pass`);
    assert.match(res.summary, /no findings array/);
  }
});

test('parseSecurityOutput handles severity case-insensitively', () => {
  const raw = JSON.stringify({
    findings: [
      { severity: 'HIGH', category: 'x', file: 'a.ts', rationale: '', remediation: '' },
    ],
    summary: '',
    passed: false,
  });
  const res = parseSecurityOutput(raw);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0]?.severity, 'high');
});

// ── A5 (0.4.0 audit): the reviewer's raw output is quoted into `summary` on every fail-closed path
// The summary is node state and reaches the record, and the reviewer is quoting a diff it may have
// been handed a secret in. Masking runs over the whole output BEFORE the 600-character slice, so a
// key that slice would split is still recognised — masking after it would keep the key's head.

test('a fail-closed summary masks a credential the reviewer echoed (A5)', () => {
  const raw =
    'sure — here is the review for sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789, ' +
    'but I am not going to emit JSON, sorry.';
  const res = parseSecurityOutput(raw);
  assert.equal(res.passed, false);
  assert.match(res.summary, /Could not parse security review output/);
  assert.doesNotMatch(res.summary, /sk-ant/);
  assert.match(res.summary, /\[REDACTED:anthropic-key\]/);
});

test('a credential the 600-character slice would split is masked, not truncated (A5)', () => {
  // 585 filler characters put the key across the 600-char boundary: the cut lands inside it. Masking
  // before the slice replaces the whole key in place, so the cut can only fall inside the label —
  // whereas slicing first would preserve the head of the key as evidence. The raw output has no `{`,
  // so it takes the first fail-closed path and is quoted whole.
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  // The space before the key is load-bearing: the pattern anchors on \b, so the key must be preceded
  // by a non-word character to be recognised at all — at this offset a word character would defeat it.
  const res = parseSecurityOutput('x'.repeat(584) + ' ' + key);
  assert.equal(res.passed, false);
  assert.doesNotMatch(res.summary, /sk-ant/, 'no part of the split key survives the slice');
});
