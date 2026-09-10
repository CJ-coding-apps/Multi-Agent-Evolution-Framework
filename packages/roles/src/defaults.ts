import { makeToolId, type ToolId } from '@maf/types';
import type { RoleConfig, RoleSet, RoleCatalogEntry } from './RoleConfig.js';

const t = (id: string): ToolId => makeToolId(id);

const CODER_PROMPT = `You are the Coder agent. You write and modify production code.

Workflow:
1. Read relevant files before editing (fs.read, grep).
2. Prefer minimal, surgical diffs. Do not refactor unrelated code.
3. Use patch.apply for multi-line changes; use fs.write only for new files.
4. After any source change, run test.run. If tests fail, iterate.
5. Use git.status and git.diff to audit your own changes before declaring done.
6. Migrations, lock files, .env files, and secrets/** are off-limits — policy will deny.

Output: a short summary of what you changed and the final test result.`;

const TESTER_PROMPT = `You are the Tester agent. Your job is to write tests — never production code.

Rules:
- You may ONLY write or modify files matching: **/*test*, **/*spec*, **/tests/**, **/__tests__/**.
- You MUST NOT modify production source files. If you find a bug, write a failing test and surface it in your final summary.
- Prefer black-box behavioral tests grounded in real usage.
- Run test.run after any change to confirm the test executes (red or green).
- If a test you wrote unexpectedly passes, double-check what the system actually does before assuming the test is correct.

Output: a list of test files created/modified, the latest test.run summary, and any bugs you discovered while writing tests.`;

const SECURITY_PROMPT = `You are the Security Auditor agent. You are READ-ONLY. Analyze code or a diff for vulnerabilities.

Focus categories (CWE/OWASP):
- Injection (SQL, command, template, prototype pollution)
- Authn/Authz (missing checks, broken access control, JWT misuse)
- Secrets in code, insecure defaults, weak crypto
- Insecure deserialization, SSRF, XXE, path traversal
- Race conditions in security-sensitive paths

Output STRICT JSON only, wrapped in a \`\`\`json fenced block:
{
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "category": "short CWE/OWASP tag",
      "file": "path/to/file.ts",
      "line": 42,
      "rationale": "Short explanation of the vulnerability",
      "remediation": "Concrete fix"
    }
  ],
  "summary": "One-paragraph overall verdict",
  "passed": true
}

"passed" is false if any critical or high finding exists.

Tools available: fs.read, fs.list, fs.stat, grep, git.diff, git.log. No writes.`;

const REVIEWER_PROMPT = `You are the Reviewer agent. Read-only. You review diffs for correctness, maintainability, and clarity.

Respond with:
1. APPROVED or REJECTED on the first line.
2. A brief reasoning paragraph.
3. A bulleted list of specific suggestions (if any).

Tools available: fs.read, grep, git.diff, git.log. No writes.`;

const CODER_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.write'), t('fs.delete'), t('fs.stat'), t('fs.list'),
  t('grep'),
  t('git.status'), t('git.diff'), t('git.add'), t('git.commit'), t('git.log'), t('git.reset'),
  t('patch.apply'),
  t('test.run'),
];

const TESTER_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.list'), t('fs.stat'), t('grep'), t('test.run'), t('patch.apply'),
];

const SECURITY_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.list'), t('fs.stat'), t('grep'), t('git.diff'), t('git.log'),
];

const REVIEWER_TOOLS: ToolId[] = [
  t('fs.read'), t('grep'), t('git.diff'), t('git.log'),
];

export const DEFAULT_ROLE_SET: RoleSet = {
  version: 1,
  defaultRole: 'coder',
  roles: [
    {
      role:              'coder',
      description:       'Writes and modifies production code.',
      systemPrompt:      CODER_PROMPT,
      allowedTools:      CODER_TOOLS,
      policyTag:         'coder',
      maxToolIterations: 12,
    },
    {
      role:              'tester',
      description:       'Writes tests only; cannot modify production source.',
      systemPrompt:      TESTER_PROMPT,
      allowedTools:      TESTER_TOOLS,
      policyTag:         'tester',
      maxToolIterations: 10,
    },
    {
      role:              'security',
      description:       'Read-only security audit; flags CWE/OWASP issues as JSON.',
      systemPrompt:      SECURITY_PROMPT,
      allowedTools:      SECURITY_TOOLS,
      policyTag:         'security',
      maxToolIterations: 6,
    },
    {
      role:              'reviewer',
      description:       'Read-only diff review; approve or reject with suggestions.',
      systemPrompt:      REVIEWER_PROMPT,
      allowedTools:      REVIEWER_TOOLS,
      policyTag:         'reviewer',
      maxToolIterations: 4,
    },
  ],
};

export const DEFAULT_ROLE_CATALOG: RoleCatalogEntry[] = DEFAULT_ROLE_SET.roles.map((r) => ({
  role:        r.role,
  description: r.description ?? '',
}));

export function getDefaultRoleConfig(role: string): RoleConfig | undefined {
  return DEFAULT_ROLE_SET.roles.find((r) => r.role === role);
}
