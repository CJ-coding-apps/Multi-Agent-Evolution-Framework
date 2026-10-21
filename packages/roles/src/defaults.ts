import { makeToolId, type RoleName, type ToolId } from '@maf/types';
import type { RoleConfig, RoleSet, RoleCatalogEntry } from './RoleConfig.js';
import { defineRoleName, DEFAULT_MAX_TOOL_ITERATIONS } from './RoleConfig.js';
import { isWriterRole } from './isWriterRole.js';

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

Tools available: fs.read, fs.list, fs.stat, grep, lcm.expand, git.diff, git.log. No writes — you hold no write tool, and a change you make to the tree fails this node, its diff recorded in the run's attestation.`;

const REVIEWER_PROMPT = `You are the Reviewer agent. Read-only. You review diffs for correctness, maintainability, and clarity.

Respond with:
1. APPROVED or REJECTED on the first line.
2. A brief reasoning paragraph.
3. A bulleted list of specific suggestions (if any).

Tools available: fs.read, grep, git.diff, git.log. No writes — you hold no write tool, and a change you make to the tree fails this node, its diff recorded in the run's attestation.`;

const CODER_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.write'), t('fs.delete'), t('fs.stat'), t('fs.list'),
  t('grep'), t('lcm.expand'),
  t('git.status'), t('git.diff'), t('git.add'), t('git.commit'), t('git.log'), t('git.reset'),
  t('patch.apply'),
  t('test.run'),
];

const TESTER_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.list'), t('fs.stat'), t('grep'), t('lcm.expand'), t('test.run'), t('patch.apply'),
];

const SECURITY_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.list'), t('fs.stat'), t('grep'), t('lcm.expand'), t('git.diff'), t('git.log'),
];

const REVIEWER_TOOLS: ToolId[] = [
  t('fs.read'), t('grep'), t('lcm.expand'), t('git.diff'), t('git.log'),
];

const ANALYST_PROMPT = `You are the Analyst agent. Read-only. You answer a question about the code, investigate, and report. You make no change.

What you do:
1. Establish exactly what the task is asking — a question, an investigation, or a report over the code as it stands.
2. Read what answers it: the files the question names, their neighbours, and the history that explains them (fs.read, fs.list, fs.stat, grep, git.log, git.diff, git.status).
3. Answer plainly, and separate what you read from what you infer. Name the files and lines you relied on.

Output: the answer to the question, and the evidence you read to reach it. If the task actually requires a change to the tree, say so — a role that writes must make that change, and this one does not.

Tools available: fs.read, fs.list, fs.stat, grep, lcm.expand, git.status, git.diff, git.log. No writes — you hold no write tool, and a change you make to the tree fails this node, its diff recorded in the run's attestation.`;

const ANALYST_TOOLS: ToolId[] = [
  t('fs.read'), t('fs.list'), t('fs.stat'), t('grep'), t('lcm.expand'), t('git.status'), t('git.diff'), t('git.log'),
];

export const DEFAULT_ROLE_SET: RoleSet = {
  version: 1,
  defaultRole: defineRoleName('coder'),
  roles: [
    {
      role:              defineRoleName('coder'),
      description:       'Writes and modifies production code.',
      systemPrompt:      CODER_PROMPT,
      allowedTools:      CODER_TOOLS,
      policyTag:         'coder',
      maxToolIterations: 12,
      // The only built-in role whose job is the change itself (D-32): a tester that adds no test
      // has often done its job, and security and reviewer hold no write tool.
      expectsChange:     true,
    },
    {
      role:              defineRoleName('tester'),
      description:       'Writes tests only; cannot modify production source.',
      systemPrompt:      TESTER_PROMPT,
      allowedTools:      TESTER_TOOLS,
      policyTag:         'tester',
      maxToolIterations: 10,
    },
    {
      role:              defineRoleName('security'),
      description:       'Read-only security audit; flags CWE/OWASP issues as JSON.',
      systemPrompt:      SECURITY_PROMPT,
      allowedTools:      SECURITY_TOOLS,
      policyTag:         'security',
      // At least the loop default (F2): a reader's cap must cover the read chain it needs
      // (`git.diff → fs.read → grep → git.log → answer`), or it fails `budget_exhausted` on a
      // task it would otherwise finish. The registry test pins every built-in reader to this.
      maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
      // D-44: a built-in reader runs in-process, where policy verdicts, secret redaction and
      // attested tool calls exist. On the cli tier a reader is handed the backend's own file
      // tools; an audit or a review that reads the tree ungoverned is the case F7 built the
      // `unexpected_change` guard for, and running it governed is what removes the need.
      execution:         'in-process',
    },
    {
      role:              defineRoleName('reviewer'),
      description:       'Read-only diff review; approve or reject with suggestions.',
      systemPrompt:      REVIEWER_PROMPT,
      allowedTools:      REVIEWER_TOOLS,
      policyTag:         'reviewer',
      maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,   // F2, as for `security`
      execution:         'in-process',   // D-44, as for `security`
    },
    {
      role:              defineRoleName('analyst'),
      // Written for the planner: it is the planner's role block that routes a question here
      // (WP-3.0b), so the description says what the role is *for*, not only what it cannot do.
      description:       'Read-only. Answers a question about the code, investigates, reports. Makes no change.',
      systemPrompt:      ANALYST_PROMPT,
      allowedTools:      ANALYST_TOOLS,
      policyTag:         'analyst',
      maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,   // F2, as for `security` and `reviewer`
      // D-43/D-44: a reader, so in-process like the other two readers, and no `expectsChange` —
      // answering a question changes nothing, and a role that owes no change must not fail for
      // making none.
      execution:         'in-process',
    },
  ],
};

export const DEFAULT_ROLE_CATALOG: RoleCatalogEntry[] = DEFAULT_ROLE_SET.roles.map((r) => ({
  role:          r.role,
  description:   r.description ?? '',
  writes:        isWriterRole(r),
  expectsChange: r.expectsChange === true,
}));

export function getDefaultRoleConfig(role: RoleName): RoleConfig | undefined {
  return DEFAULT_ROLE_SET.roles.find((r) => r.role === role);
}
