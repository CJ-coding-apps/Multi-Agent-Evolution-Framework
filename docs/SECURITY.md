# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub's
[private vulnerability reporting](https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework/security/advisories/new),
not as a public issue. If you cannot use that form, open an issue that says only that you have a security
report to share, and wait for a maintainer to open a private channel — please do not put the details in
the issue.

Useful to include: the version, the command and the role set involved, what you did, and what happened. A
reproduction is worth more than a description.

## Supported versions

MAF is pre-1.0 (currently 0.2.0). Only the most recent release is supported; fixes land there and are not
backported. Please reproduce against the latest version before reporting.

## What this project does with your data

Worth stating plainly, because it decides what is and is not a vulnerability here.

- **It runs on your machine and opens no port.** MAF is a command-line orchestrator: it starts no server
  and listens on no socket. The MCP servers it can mount are child processes it talks to over stdio.
- **It drives coding agents you already have, with your credentials.** A node's work is handed to a
  backend CLI (Claude Code, Codex, and the others listed in the README), which runs as you and sends its
  traffic to that provider under that provider's terms. That is the request, not a leak.
- **The memory graph is local.** It is a Kuzu database on disk, at the path you configure.
- **The attestation bundle is written locally, in the clear.** It records each tool call's input and
  result, the approvals, the security findings and the diff hashes. Before either the bundle or the memory
  graph sees a tool call, credentials are stripped from its input and from the result's stdout, stderr and
  metadata (`gatedExec.ts`). The scrubber is **format-based and shallow**, and both limits are deliberate:
  it knows eight credential shapes (AWS, Anthropic, OpenAI, Google, a GitHub PAT, a Slack token, a bearer
  token, a PEM private key) and redacts only the top-level string values of the input, because a broader
  pattern set would mangle the evidence the bundle exists to be. So a credential in another format, or one
  nested a level down inside the input, is recorded as written. Treat a bundle as containing whatever the
  run printed and whatever the agent chose to type.
- **On the default execution tier, no tool call is recorded at all.** Redaction describes the `in-process`
  path above. A `cli`-tier role's tools run inside the backend CLI, so there is nothing to record — see
  *The execution-tier boundary* below.

Two things a bundle does **not** establish today, stated rather than implied:

- **A valid signature is not evidence of who produced the bundle.** The signing key is read from
  `MAF_SIGNING_KEY` and falls back to a fixed, public value — `'dev-secret'`
  (`packages/attestation/src/Attestor.ts`). With the default, anyone can produce a bundle that verifies.
  Set `MAF_SIGNING_KEY` to a secret of your own before treating a bundle as evidence of authorship.
- **It is signed, not sealed.** Anyone who can write to the bundle's directory can replace it with one
  they signed with the same key.

Anything that breaks one of those statements — a bundle written outside the directory you configured, a
node dispatched that the policy engine should have refused, a path a tool declared escaping the project
root — is a vulnerability, and we would want to hear about it.

## Out of scope

Findings that depend on an attacker already running code as the user who runs MAF; and the content of the
repositories you choose to have it modify.

## The security model

What maf checks, what it does not, and where each boundary is drawn. Sections are added as the
boundaries are implemented; anything not written here is not a guarantee.

### The post-coder security gate: what it reads

Every coder node's change is reviewed by `SecurityReviewGate` before the node completes — on both
execution paths, and whatever the run outcome. The gate reviews **a diff of the working tree against the
commit the node started from**, computed by `snapshotDiff` (`packages/git-ops/src/SnapshotDiff.ts`).

"Against the commit the node started from, not `HEAD`" is load-bearing: an agent that commits its own
work — normal behaviour for a CLI coding agent — would otherwise diff clean, and an empty diff passes
every security rule.

What the diff therefore contains:

| Change | In the diff? |
|---|---|
| Modified tracked file | yes |
| New file, never staged | yes — the tree is staged into a throwaway index before diffing |
| New file, staged | yes |
| Work the agent committed during the node | yes — the base is not `HEAD` |
| Deleted file | yes |
| **File matched by `.gitignore`** | **no** |
| Anything outside the working directory | no — it is not in the tree at all |

#### Two limits, stated rather than implied

**`.gitignore`d files are outside the diff.** `git add -A` respects `.gitignore`, so a `.env`, a
`secrets/` directory, or a build artifact is not staged and not reviewed. This is deliberate — those files
are excluded precisely because they are not the deliverable — but it does mean **the gate's silence about
a file is not evidence that the file was not written.** A `.gitignore`d write is caught on the tool path
instead: not by this diff, and no longer by a policy rule alone — every path a tool declares is confined
to the project root before any rule is read, so a write outside the root is refused whatever the rule set
says (see *Path confinement* below). When the write comes from a CLI-tier agent's own file tools, it is
not visible to maf at all. See the tier boundary below.

**An oversized diff is an error, never a truncated review.** Past 8 MB the runner fails the node rather
than reviewing the part it managed to read. Reviewing a truncated diff would report the cut portion as
reviewed, which is the same fail-open the diff exists to close, reached a third way.

#### A missing repository is an error

If there is no usable repository to diff in, the gate fails the node and says how to fix it — it does not
report a clean diff. `git init` with no commits is *not* this case: the empty tree is a valid base, so the
first change in a fresh repository is reviewable.

### The execution-tier boundary

A role runs in one of two tiers:

- **`in-process`** — maf drives every turn and every tool call through the policy engine and processor
  pipeline. Governance is real here.
- **`cli`** (the default) — maf hands the backend CLI one prompt and reads back one result. The agent
  runs its own tools, so maf sees **no individual tool call**: not the arguments, not the policy verdict,
  not the path.

The coder diff above is the one thing maf still observes on the `cli` tier, and it observes it only
*after* the node finishes.

No shipped role set sets `execution: in-process` (no role in the built-in catalogue names an `execution`,
and the field defaults to `cli`), so **maf's default posture is ungoverned; governance is opt-in per
role.** That is the honest reading of the default and it is the reason the tier is worth knowing before
trusting a run.

The tier is *not* yet recorded in the attestation bundle: today it is a local in `RoleDispatcher`, so a
bundle says what a run produced but not how each node was executed. Until it is recorded per role, the
only way to know a run's posture is to read the role set it was dispatched with.

### Path confinement

Every path a tool declares for a call is resolved against the project root and proven to lie inside it
before anything acts on it — `resolveInside` (`packages/types/src/paths.ts`), whose result is the value
both the policy engine checks and the tool executes with.

What this refuses:

| Attempt | Refused? |
|---|---|
| `../outside.txt` — a relative traversal | yes |
| `/etc/passwd` — an absolute path | yes |
| A symlink whose *name* is inside the root and whose *target* is outside | yes |
| A symlink pointing *outside* that does not exist yet (dangling) | yes |
| A directory entry that resolves outside, then a path below it | yes |
| A symlink that stays inside the root | **no** — resolved and allowed |
| A path in the root, however it is spelled (`./a`, `sub/../a`, `a//b`) | **no** — served normally |

The check happens in two places, and neither is redundant. In the **policy engine** it runs before the
rule list, so a path outside the root is refused with a `Deny` even when no rule is loaded — confinement
is not a rule and an empty policy file does not turn it off. In each **fs tool's `execute`** the same
function runs again, so a tool called directly, without passing through the policy engine, is confined
identically. The checked path and the executed path are the same value because both come from that one
call, which is what stops a spelling from being confined in one place and not the other.

Three things this does **not** cover, so none is mistaken for it:

- **The check and the open are two steps.** `resolveInside` returns a name it has shown to be inside the
  root; the tool then opens that name. A symlink put in place *between* those two steps — one component
  swapped after the path was resolved and before the write or read follows it — is not seen by the check,
  and the operation lands wherever the new link points. Closing it means opening each component with
  symlink-following disabled and assembling the result from file descriptors, which is out of proportion
  to what maf needs today: it is a race that requires already running code inside the project, and
  confinement still holds for every path not modified mid-call.
- It confines paths to the project root (the directory of `ctx.projectRoot`), not to the files a role is
  *allowed* to touch. Which files inside the root are fair game is a policy question — `pathGlob` and
  `allowedPathGlobs`.
- It applies to the paths a tool **declares** — `ToolPlugin.declaredPaths(input)`, a pure function of the
  input. For a `cli`-tier role, whose tool calls maf never sees, no path is declared and none is checked.
