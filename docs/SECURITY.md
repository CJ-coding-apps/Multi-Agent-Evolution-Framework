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

MAF is pre-1.0 (currently 0.2.1). Only the most recent release is supported; fixes land there and are not
backported. Please reproduce against the latest version, on Node 22 — the version CI builds and tests
on — before reporting.

## What this project does with your data

Worth stating plainly, because it decides what is and is not a vulnerability here.

- **It runs on your machine and opens no port.** MAF is a command-line orchestrator: it starts no server
  and listens on no socket. It mounts no MCP servers of its own; a backend CLI may run its own, under
  that CLI's configuration.
- **It drives coding agents you already have, with your credentials.** A node's work is handed to a
  backend: a CLI (Claude Code, Gemini, Codex), which runs as you, or an HTTP API (OpenRouter, a local
  Ollama server). Either sends its traffic to that provider under that provider's terms. That is the
  request, not a leak.
- **The memory graph is local.** It is a Kuzu database on disk, at `.maf/memory.kuzu` in the target
  directory.
- **The attestation bundle is written locally, in the clear**, at `.maf/attestations/<runId>.bundle.json`.
  It records each in-process tool call's input and result — refused calls included, with the verdict and,
  where a rule decided, the rule's id — the security findings and the run's outcome. Its `approvals` and
  `diffHashes` fields are always empty in 0.2.1: nothing fills them. Before either the bundle or the
  memory graph sees a tool call, credentials are stripped from its input and from the result's stdout,
  stderr and metadata (`gatedExec.ts`). The scrubber is **format-based and shallow**, and both limits are deliberate:
  it knows eight credential shapes (AWS, Anthropic, OpenAI, Google, a GitHub PAT, a Slack token, a bearer
  token, a PEM private key) and redacts only the top-level string values of the input, because a broader
  pattern set would mangle the evidence the bundle exists to be. So a credential in another format, or one
  nested a level down inside the input, is recorded as written. Treat a bundle as containing whatever the
  run printed and whatever the agent chose to type.
- **On the default execution tier, no tool call is recorded at all.** Redaction describes the `in-process`
  path above. A `cli`-tier role's tools run inside the backend CLI, so there is nothing to record — see
  *The execution-tier boundary* below.

How a bundle is signed, and what a signature does **not** establish today, stated rather than implied:

- **Without `MAF_SIGNING_KEY`, a valid signature is evidence of nothing.** The bundle is signed with
  HMAC-SHA256 over its JSON, keyed by `MAF_SIGNING_KEY`. When that is unset — or empty, or set to the
  published development value — a run prints one warning line to stderr and signs with the public
  development key `'dev-secret'` (`packages/attestation/src/Attestor.ts`). The bundle then says
  `keySource: "dev"`, inside the signed payload, so the label cannot be stripped or flipped without
  breaking the signature. `Attestor.verify(bundle, { secret })` returns `{ valid, keySource }`: a
  dev-signed bundle verifies, and anyone can produce one, and a bundle re-signed with the development key
  cannot pass as `keySource: "env"`. Set `MAF_SIGNING_KEY` to a secret of your own before treating a
  bundle as evidence of authorship.
- **The key is not hidden from the agent.** Backend CLIs and `test.run` inherit MAF's whole environment,
  `MAF_SIGNING_KEY` included, so an agent that can run a command can read the key and sign a bundle of
  its own. A signature shows that whoever made the bundle held the key; on a run whose agent could run
  commands, that includes the agent.
- **It is signed, not sealed.** Anyone who can write to the bundle's directory can replace it with one
  they signed with the same key.

Anything that breaks one of those statements — a bundle written outside the target's `.maf/attestations/`, a
node dispatched that the policy engine should have refused, a path a tool declared escaping the project
root — is a vulnerability, and we would want to hear about it.

## Out of scope

Findings that depend on an attacker already running code as the user who runs MAF; and the content of the
repositories you choose to have it modify.

## The security model

What maf checks, what it does not, and where each boundary is drawn. Sections are added as the
boundaries are implemented; anything not written here is not a guarantee.

### The post-task security gate: what it reads

Every writer role's change is reviewed by `SecurityReviewGate` before the node completes — on both
execution tiers, including after a node that ran out of budget or failed. A writer is a role that holds
`fs.write`, `fs.delete`, `patch.apply`, `git.commit`, `git.reset` or `git.add`; the role's name plays no
part, so a tester holding `patch.apply` is reviewed like a coder. On the `cli` tier `RoleDispatcher` runs
the gate after the backend returns; on the `in-process` tier the `security-gate` processor runs it at
`task_end` — the default processor bundle includes it, and a harness whose `processorBundles` leaves it
out gets no review on that tier. The gate reviews **a diff of the working tree against the commit the
node started from**, computed by `snapshotDiff` (`packages/git-ops/src/SnapshotDiff.ts`).

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
| **`.maf/` at the root of the working tree** | **no** — excluded by name: it is MAF's own state (transcripts, memory graph, bundles), written by MAF rather than the agent, and it grows during the run. A nested directory that merely shares the name is reviewed |
| Anything outside the working directory | no — it is not in the tree at all |

#### Limits, stated rather than implied

**`.gitignore`d files are outside the diff.** `git add -A` respects `.gitignore`, so a `.env`, a
`secrets/` directory, or a build artifact is not staged and not reviewed. This is deliberate — those files
are excluded precisely because they are not the deliverable — but it does mean **the gate's silence about
a file is not evidence that the file was not written.** A `.gitignore`d write is caught on the tool path
instead: not by this diff, and no longer by a policy rule alone — every path a tool declares is confined
to the project root before any rule is read, so a write outside the root is refused whatever the rule set
says (see *Path confinement* below). When the write comes from a CLI-tier agent's own file tools, it is
not visible to maf at all. See the tier boundary below.

**`.maf/` is outside the diff**, by name, for the reason in the table. Tool writes into it are denied by
the shipped policy (`deny-maf-dir`) on the `in-process` tier; a `cli`-tier agent's own writes there are
not reviewed.

**An oversized diff is an error, never a truncated review.** There are two caps, and neither truncates.
`snapshotDiff` fails the node when the diff passes 8 MB. `SecurityReviewGate` refuses a diff longer than
its own cap — `maxDiffChars`, 60,000 characters by default, set where the gate is constructed (no CLI flag
sets it in 0.2.1) — by throwing `GateRefused`, which names the diff's size and the cap, before any model
call. The refusal is recorded in the bundle's security findings and as a `Failure` node, and it is never
retried. Reviewing a truncated diff would report the cut portion as reviewed, which is the same fail-open
the diff exists to close, reached a third way.

**The verdict comes from the severities, not from the reviewer's say-so.** Any `critical` or `high`
finding fails the node with `GateRefused`; the reviewing model's own `passed` boolean is ignored, because
a model has said `passed: true` beside its own critical finding. Output with no JSON, invalid JSON, no
`findings` array, or a finding whose severity cannot be read fails closed. A refusal is terminal: the
scheduler retries only transport failures, and the start commit is captured once per node, so a retry
could not diff a committed change away in any case.

**A `cli`-tier role that holds no write tool is not reviewed**, although its backend CLI has file tools of
its own. On the `cli` tier the allowlist is not passed to the backend, so it does not limit what the agent
can do — it only decides whether the gate runs.

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

The writer-role diff above is the one thing maf still observes on the `cli` tier, and it observes it only
*after* the node finishes — and only for a role that holds a write tool. Policy refusals, redaction and
tool-call records exist on the `in-process` tier alone.

No shipped role set sets `execution: in-process` (no role in the built-in catalogue names an `execution`,
and the field defaults to `cli`), so **maf's default posture is ungoverned; governance is opt-in per
role.** That is the honest reading of the default and it is the reason the tier is worth knowing before
trusting a run.

The tier is *not* yet recorded in the attestation bundle: today it is a local in `RoleDispatcher`, so a
bundle says what a run produced but not how each node was executed. Until it is recorded per role, the
only way to know a run's posture is to read the role set it was dispatched with.

### Path confinement

Every path a tool declares for a call is resolved against the project root and proven to lie inside it
before anything acts on it — `resolveInside` (`packages/types/src/paths.ts`). For the `fs.*` tools its
result is the value both the policy engine checks and the tool executes with; for the other
path-declaring tools, see the paragraph after the table.

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
identically. For the `fs.*` tools the checked path and the executed path are the same value because both
come from that one call, which is what stops a spelling from being confined in one place and not the
other. `git.diff` declares and diffs one list (`paths`). `git.add`, `grep` and `patch.apply` are confined
by the policy engine only: it checks the resolved form of what they declare, and the tool then hands its
own input to git (with literal pathspecs), to rg or grep (after `--`), or to `patch`. That is the same
input, but not one resolved value, and a direct call that skips the policy engine gets no confinement
from MAF.

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

### `test.run` executes project code

`test.run` runs the target project's own test command in the project directory: `npm test`, `npx vitest`,
`npx jest`, `bun test`, `python -m pytest` or `cargo test`, detected from the project or chosen by the
caller (`packages/tools/src/plugins/test-runner.ts`). That executes whatever the project's tests and
scripts contain — including tests the tester role wrote earlier in the same run. It runs with MAF's
environment, `MAF_SIGNING_KEY` included, and for as long as the caller's `timeout` asks (120 seconds by
default); on timeout the process it started gets `SIGTERM`, and its children are not signalled.

`test.run` declares no path, so no path rule applies to it; a policy can deny the tool to a role, but it
cannot see what the tests do. Granting a role `test.run` grants it code execution as the user running
MAF.
