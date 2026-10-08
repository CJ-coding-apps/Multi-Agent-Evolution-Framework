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
