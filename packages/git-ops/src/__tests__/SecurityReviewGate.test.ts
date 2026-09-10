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
