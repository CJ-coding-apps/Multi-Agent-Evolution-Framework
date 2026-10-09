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

MAF is pre-1.0 (currently 0.3.0). Only the most recent release is supported; fixes land there and are not
backported. Please reproduce against the latest version, on Node 22 — the version CI builds and tests
on — before reporting.

## What this project does with your data

Worth stating plainly, because it decides what is and is not a vulnerability here.

- **It runs on your machine and opens no port.** MAF is a command-line orchestrator: it starts no server
  and listens on no socket. It mounts no MCP servers of its own, and it spawns `claude` with
  `--strict-mcp-config` and an empty `--mcp-config`, so `claude` starts none of yours either; `gemini` is
  given an MCP allowlist that names no configured server (not checked against a live `gemini`), and
  `codex` is given no MCP flag, so MAF does nothing to stop the servers its configuration names.
- **It drives coding agents you already have, with your credentials.** A node's work is handed to a
  backend: a CLI (Claude Code, Gemini, Codex), which runs as you, or an HTTP API (OpenRouter, a local
  Ollama server). Either sends its traffic to that provider under that provider's terms. That is the
  request, not a leak.
- **The memory graph is local.** It is a Kuzu database on disk, at `.maf/memory.kuzu` in the target
  directory.
- **The attestation bundle is written locally, in the clear**, at `.maf/attestations/<runId>.bundle.json`.
  It is an in-toto Statement (`_type: https://in-toto.io/Statement/v0.1`). Its subjects are the changes
  the run's writer nodes left: one per node, named `<nodeId>.diff`, whose digest is the sha256 of the diff
  the post-task security gate reviewed, on either tier; a run that changed nothing has none. Its predicate
  (`predicateType: https://maf.dev/attestation/run/v1`) records each in-process tool call's input and
  result — refused calls included, with the verdict and, where a rule decided, the rule's id — every
  decision the approval gate and the review gate made (in `approvals`), the security findings and the
  run's outcome. Before either the bundle or the
  memory graph sees a tool call, credentials are stripped from its input and from the result's stdout,
  stderr and metadata (`gatedExec.ts`). The scrubber is **format-based and shallow**, and both limits
  are deliberate: it knows eight credential shapes (AWS, Anthropic, OpenAI, Google, a GitHub PAT, a Slack token, a bearer
  token, a PEM private key) and redacts only the top-level string values of the input, because a broader
  pattern set would mangle the evidence the bundle exists to be. So a credential in another format, or one
  nested a level down inside the input, is recorded as written. Treat a bundle as containing whatever the
  run printed and whatever the agent chose to type. Failure messages, which also reach the bundle's
  run outcome and the memory graph, are masked the same way: a failed node's output tail with those eight
  formats, and a backend's stderr or HTTP error-body tail with five of them (bearer tokens, `sk-` keys,
  Google, GitHub and AWS keys).
- **A refused escalation leaves a record in the clear** at `.maf/approvals/pending/<id>.json` when no one
  could be asked: the approval request (its id, the run, the task, the tool and the rule), the request's
  hash, the declared paths, a timestamp and the reason. The tool's input is not written there.
- **On the `cli` tier, no tool call is recorded at all.** Redaction describes the `in-process` path
  above. A `cli`-tier role's tools run inside the backend CLI, so there is nothing to record — see
  *The execution-tier boundary* below.

How a bundle is signed, and what a signature does **not** establish today, stated rather than implied:

- **What is signed is the statement's canonical JSON, so anyone holding the key can check it.** The
  bundle's `signature` is HMAC-SHA256, lowercase hex, over every other field of the file serialized by
  RFC 8785 (the JSON Canonicalization Scheme, `packages/attestation/src/jcs.ts`): keys sorted by UTF-16
  code unit at every depth (so `"10"` before `"2"`), numbers as ECMAScript writes them, no whitespace.
  A string holding a lone UTF-16 surrogate, which RFC 8785 does not admit, is written as a `\u` escape,
  as `JSON.stringify` writes it. So re-serializing a bundle, in any key order or indentation, does not
  break it, and changing any byte of the statement does. A statement whose subjects are not exactly its
  predicate's `diffHashes` (same names, same digests, each once) does not verify. `maf attest verify
  <bundle>` checks a bundle and prints `valid`, the `keySource` it checked against, the number of
  subjects, and `legacy` when the signature matched as a 0.2.x bundle's; it exits 1 with the reason
  when the bundle does not verify, cannot be read, or is not a bundle.
- **Without `MAF_SIGNING_KEY`, a valid signature is evidence of nothing.** The key is `MAF_SIGNING_KEY`.
  When that is unset — or empty, or set to the published development value — a run prints one warning
  line to stderr and signs with the public development key `'dev-secret'`
  (`packages/attestation/src/Attestor.ts`), and `maf attest verify` checks against that key after a note
  of its own on stderr (`verifying with the public development key; set MAF_SIGNING_KEY to verify against
  yours`). The bundle then says `keySource: "dev"` in its predicate,
  inside the signed statement, so the label cannot be stripped or flipped without breaking the
  signature. `Attestor.verify(bundle, { secret })` returns `true` only when the signature matches that
  key *and* the bundle's `keySource` names that kind of key; `Attestor.inspect` returns
  `{ valid, keySource, legacy }`; `BundleSigner.verify` applies the same rule. So a dev-signed bundle
  verifies, and anyone can produce one, and a bundle re-signed with the development key cannot pass as
  `keySource: "env"`. Set `MAF_SIGNING_KEY` to a secret of your own before treating a bundle as evidence
  of authorship.
- **A 0.2.x bundle is custom JSON, signed over `JSON.stringify` in the order its fields were written.**
  It still verifies, against the key you supply, and is reported as `legacy`; a 0.2.1
  bundle's `keySource` is held to the rule above. A 0.2.0 bundle carries no `keySource`, so it verifies
  on its signature alone, and verifying one with the development key proves only that it was signed
  with the development key.
- **The key is not hidden from the agent.** The backend CLIs and every tool that starts a process —
  `test.run`, the `git.*` tools, `grep` (rg or grep) and `patch.apply` — inherit MAF's whole environment,
  `MAF_SIGNING_KEY` included. `test.run` runs project code with it. The `git.*` tools never run a hook,
  even one the agent wrote (see *The agent's git tools* below). So an agent that can run a command —
  directly, or through a test it wrote — can read the key and sign a bundle of its own. A signature
  shows that whoever made the bundle held the key; on a run whose agent could run commands, that
  includes the agent.
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

Every writer role's change is reviewed by `SecurityReviewGate` before the node completes. A writer is a
role that holds `fs.write`, `fs.delete`, `patch.apply`, `git.commit`, `git.reset`, `git.add` or
`test.run` (which runs the project's own code); the role's name plays no part, so a tester holding
`patch.apply` is reviewed like a coder. The review runs once per
attempt, at the first of these that reaches it:

- **`cli` tier:** `RoleDispatcher` runs it after the backend returns, whether the result was a success, a
  failure or empty output.
- **`in-process` tier:** the `security-gate` processor runs it at `task_end`, whatever outcome the loop
  returns (completed, `budget_exhausted`, failed). The default processor bundle includes that
  processor; for a harness whose `processorBundles` leaves it out, the dispatcher runs the same review
  right after the loop returns.
- **Either tier, when the backend or the loop throws** — a timed-out turn, a backend that never started:
  the dispatcher runs the review on whatever the agent left in the tree before the error propagates. A
  refusal outranks the error; a clean or empty diff lets the original error through for the scheduler
  to classify ([D-31](DECISIONS.md)). In-process, the dispatcher fires `task_end` for a loop that threw,
  so the processor's review runs there.

The reviewer is the run's backend, called on the `cli` tier (one prompt, one answer) in the directory
the run works in. The diff is in the prompt, so the call asks for no tools of the backend's own
(`nativeTools: false`): `claude` gets `--tools ""`, and cannot edit the tree it is reviewing after the
review passes it; `codex` and `gemini` have no known flag for that and keep their tools (see *The
execution-tier boundary*).

The gate reviews **a diff of the whole repository's working tree against the commit the node started
from**, computed by `snapshotDiff` (`packages/git-ops/src/SnapshotDiff.ts`) with the `:(top)` pathspec,
so a change anywhere in the repository is in it even when MAF was pointed at a subdirectory. In a run
with worktree isolation the repository is the run's own worktree (see *Worktree isolation* below).

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
| A file an agent-written `.gitattributes` marks `-diff` or `binary`, or hands to a diff driver (`textconv`, an external command) | yes, as text — the diff is taken with `--text --no-ext-diff --no-textconv`; a genuinely binary file prints as bytes, so one too large to review whole is refused by the cap below |
| **File matched by `.gitignore`** | **no** |
| A change elsewhere in the repository than the directory MAF was pointed at | yes — the pathspec is the whole repository |
| MAF's configuration under `.maf/`: `policy.yaml`, `roles.yaml`, `config.yaml`, `prompts/` | yes — an agent could rewrite it to shape the next run |
| **This run's runtime state under `<cwd>/.maf/`**: `runs/`, `cache/`, `memory.kuzu`, `lcm.db*`, `transcripts/`, `attestations/`, `harnesses/`, `goldens/results/`, `evolve/` | **no** — excluded by name ([D-29](DECISIONS.md)): MAF writes it, it grows during the run, and it would push an honest diff past the gate's cap. A `.maf/` directory elsewhere in the repository is ordinary content |
| `.maf/worktrees/` — earlier runs' worktrees | **no** — it carries a `.gitignore` of its own that ignores everything in it ([D-35](DECISIONS.md)) |
| `<cwd>/.maf/approvals/` | no — pending records are written by MAF when nobody can answer an escalation, never by the agent (runtime state since 0.3.0) |
| Anything else under `<cwd>/.maf/` | yes — it is not on the runtime-state list |
| Anything outside the repository | no — it is not in the tree at all |

#### Limits, stated rather than implied

**`.gitignore`d files are outside the diff.** `git add -A` respects `.gitignore`, so a `.env`, a
`secrets/` directory, or a build artifact is not staged and not reviewed. This is deliberate — those files
are excluded precisely because they are not the deliverable — but it does mean **the gate's silence about
a file is not evidence that the file was not written.** A `.gitignore`d write is caught on the tool path
instead: not by this diff, and no longer by a policy rule alone — every path a tool declares is confined
to the project root before any rule is read, so a write outside the root is refused whatever the rule set
says (see *Path confinement* below). When the write comes from a CLI-tier agent's own file tools, it is
not visible to maf at all. See the tier boundary below.

**A filter driver changes what is staged.** `git add -A` runs the `clean` command of any filter the
repository's own configuration defines (`filter.<name>.clean`, as git-lfs or git-crypt set up), and an
agent-written `.gitattributes` can select one for any file, so the diff shows what the filter produced
rather than the file. MAF does not override attributes when it stages the tree.

**This run's runtime state under `.maf/` is outside the diff**, by name, for the reason in the table;
the rest of `.maf/` — the configuration — is reviewed. Tool writes anywhere under `.maf/` are denied by
the shipped policy (`deny-maf-dir`) on the `in-process` tier; a `cli`-tier agent's own writes to a
runtime-state path are not reviewed.

**An oversized diff is an error, never a truncated review.** There are two caps, and neither truncates.
`snapshotDiff` fails the node when the diff passes 8 MB. `SecurityReviewGate` refuses a diff longer than
its own cap — `maxDiffChars`, 60,000 characters by default, set where the gate is constructed (no flag or
`.maf/config.yaml` key sets it) — by throwing `GateRefused`, which names the diff's size and the cap,
before any model call. The refusal is recorded in the bundle's security findings and as a `Failure` node,
and it is never retried. Reviewing a truncated diff would report the cut portion as reviewed, which is
the same fail-open the diff exists to close, reached a third way.

**The verdict comes from the severities, not from the reviewer's say-so.** Any `critical` or `high`
finding fails the node with `GateRefused`; the reviewing model's own `passed` boolean is ignored, because
a model has said `passed: true` beside its own critical finding — and, the other way round, a review
that says `passed: false` with only medium, low or info findings passes. Output with no JSON, invalid JSON, no
`findings` array, or a finding whose severity cannot be read fails closed. A refusal is terminal: the
scheduler retries only transport failures, and the start commit is captured once per node, so a retry
could not diff a committed change away in any case. A reviewer that times out, exits non-zero without
output, cannot start, or whose HTTP request fails, aborts or gets a 5xx has judged nothing: that is a
`TransportError`, retried like any other transport failure, not a refusal. A reviewer that answers with
a failure (a non-zero exit with output, an HTTP 4xx) usually leaves no readable findings, so the review
fails closed as a refusal.

**A `cli`-tier role that holds no write tool is not reviewed**, although its backend CLI has file tools of
its own. On the `cli` tier the allowlist is not passed to the backend, so it does not limit what the agent
can do — it only decides whether the gate runs. The built-in `security` and `reviewer` roles are such
roles; what they write in the run's tree is reviewed by no gate, and on success it is committed to the
run's branch with everything else (see *Worktree isolation*).

#### A missing repository is an error

If there is no usable repository to diff in, the gate fails the node and says how to fix it — it does not
report a clean diff. `git init` with no commits is *not* this case: the empty tree is a valid base, so the
first change in a fresh repository is reviewable (with `--no-worktree`; a worktree needs a commit to
start from).

### The human review gate

A run given a `ReviewGate` also puts every writer's change before a reviewer — a person behind a
prompt, or whatever the `reviewer` function the gate is constructed with asks. The review runs for
exactly the roles the security gate reviews, at the same moments, on the same diff, **after** the
security gate has passed it and never for a change it refused: nobody is asked to approve what the
gate would not pass. An unchanged tree is not sent. A diff that cannot be read fails the node before
any reviewer is asked; the gate takes the diff itself, and an empty one handed to it is an error,
never an approval.

`maf run` constructs the gate only when the harness requires review or the operator asks for it with
`--review` ([D-34](DECISIONS.md)). Otherwise no gate is wired: nobody is asked, nothing is recorded, and
no writer waits on a reviewer. The reviewer `run` builds is the terminal: when stdin is a terminal and
`MAF_HEADLESS=1` is not set, it writes to stderr the node, its role, the commit the diff was taken
against, the diff's sha256 and the diff itself — up to 200 lines or 20 KB, counting what it leaves out,
with control characters escaped — and reads one line. Only `approve` approves; `deny`, any other line,
and the end of input deny. A line typed before the prompt appeared is discarded rather than taken as the
answer, and one prompt is shown at a time.

Only an approval from a named reviewer is an approval. A denial, no answer within the gate's timeout
(10 minutes by default, set where the gate is constructed; `run` sets none, so the default applies), a
reviewer that fails before deciding, and an answer that is not a decision are all non-approvals.

- **Required** (`reviewGate: { required: true }` in the harness): the node waits for the decision, and
  anything but an approval fails it with `ReviewRefused` — a verdict, never retried. Like a security
  refusal, a denial of what a throwing backend left behind outranks the backend's error.
- **Advisory** (the default, so what `--review` builds for a harness that does not require review):
  the node waits for the decision too, bounded by the gate's timeout, so the outcome is on the record
  before the bundle is signed, but completes whatever the decision is.

When no reviewer is available — stdin is not a terminal, or `MAF_HEADLESS=1` — `--review` alone prints
one line and the run goes on without a gate. A harness that requires review gets no gate either, and
then each writer's change is refused with `ReviewRefused`: fail closed. With worktree isolation off and
uncommitted or untracked changes already in the tree, `--review` is refused before anything runs,
because the reviewer would be shown the user's own edits as the run's change.

Either way the request and its outcome go into the bundle's `approvals`: the request id; the decision
(`Approved`, `Rejected` or `TimedOut`), who made it and their comment; the commit the diff was taken
against; the diff's sha256; and an in-toto Statement binding the decision to that digest.

`reviewGate` is part of the harness, so the harness sha says whether review was required. A harness
that says `required: true` is never run with an advisory gate or with none: each writer's change is
refused with `ReviewRefused` instead, since the bundle would otherwise name a configuration that
required a review nobody was asked for. A `legacy-default` harness minted from `roles.yaml` never sets
`reviewGate`; a harness file that does is brought in with `maf harness import` and run with
`--harness <id>` or `maf harness set-current`. `maf evolve` carries a parent harness's `reviewGate` into
every candidate it builds.

### Escalated tool calls

An `Escalate` verdict is the one policy refusal a person can lift, one call at a time, on a terminal; a
run with no terminal, or with `MAF_HEADLESS=1`, refuses it and writes the pending record described above
([D-02](DECISIONS.md)). Each decision is bound to a hash of the tool id, its input, the declared paths and
the rule id, so an approval cannot be replayed for another call or for an input changed while the person
was deciding, and every decision is attested. [POLICY.md](POLICY.md#escalate-asking-a-person) has the
prompt, the confirmation code, the timeout and the records. `maf goldens`, `maf evolve` and
`maf inprocess-demo` always run headless.

### The execution-tier boundary

A role runs in one of two tiers:

- **`in-process`** — maf drives every turn and every tool call through the policy engine, the approval
  gate and the processor pipeline. Governance is real here. With `claude`, each turn is spawned with
  `--tools ""`, so the backend has no built-in tool of its own, and with `--strict-mcp-config` and an
  empty `--mcp-config`, so it has no MCP tool either: the only tools in the loop are MAF's
  ([D-33](DECISIONS.md)).
- **`cli`** — maf hands the backend CLI one prompt and reads back one result. The agent
  runs its own tools, so maf sees **no individual tool call**: not the arguments, not the policy verdict,
  not the path. MAF passes no hook flags, and no permission flags but one: Codex is invoked with
  `--full-auto`, its sandboxed automatic mode, on every `cli`-tier call — the planner's and the
  reviewer's included — and the `UNGOVERNED` banner says so when the backend is `codex`. Otherwise the
  backend acts under its own permission settings. `claude` is still given the empty, strict MCP
  configuration; `gemini` an MCP allowlist that names no configured server; `codex` no MCP flag.

The writer-role diff above is the one thing maf still observes on the `cli` tier, and it observes it only
*after* the node finishes — and only for a role that holds a write tool. Policy refusals, approved
escalations, redaction and tool-call records exist on the `in-process` tier alone; the human review gate
reviews a writer's diff on either tier. The planner's call and the security
reviewer's call are `cli`-tier calls in this sense, whatever tier the roles run on, with one difference:
they need only text, so `claude` is spawned for them with `--tools ""`, its own tools off, as for an
in-process turn. `codex` and `gemini` have no known flag for that, and keep their tools on these calls.

A role's `execution` field defaults by the tools it holds ([D-01](DECISIONS.md)): `in-process` for a role
that holds a write tool, `cli` for any other. A writer lands on the `cli` tier only by its own
`execution: cli` or because the adapter cannot run the in-process loop (`codex`, `gemini`, `ollama`,
`openrouter`), and then only under `--allow-ungoverned`, which prints an `UNGOVERNED` banner; without it
`maf run` refuses before planning. So **maf's default posture is governed for writers; a read-only role
still runs on the ungoverned `cli` tier unless it sets `execution: in-process`.**

The tier is *not* yet recorded in the attestation bundle, and neither is `--allow-ungoverned`: a bundle
says what a run produced but not how each node was executed. The harness it names carries each role's
`execution` setting, if any, and the builder id names the adapter; together they say which tier each role
was meant to get.

### Recalled history is untrusted text

Recalled failure output and LCM excerpts are agent output from earlier runs and enter later planner
prompts as untrusted text. The planner's prompt carries a `<past-failures>` block — up to five failures
recalled from the memory graph, each with the error a failed node left, which can quote a backend's own
output tail — and `<past-context>` excerpts from LCM. Agents wrote them, or wrote what they quote; MAF
does not filter them or tell the model they are untrusted, so text planted in one run can steer a later plan.
What it cannot do is widen a plan's privileges: every role name the planner emits is checked against the
role set, and every node runs under its role's tier, policy and gates.

### Worktree isolation

`maf run` works in a git worktree of its own ([D-03](DECISIONS.md)): `createForRun` checks out the
current HEAD at `.maf/worktrees/<runId>` on a new branch `maf/<runId>`, and the agents, the planner and
the security reviewer work there — in the same subdirectory of it when MAF was pointed at a subdirectory.
What that separates, and what it does not:

- **Your checkout is not touched.** Your files, index, `HEAD` and `.git/config` are byte-identical after
  a run (`cli/run-acceptance.test.ts` and `git-ops/WorktreeManager.isolation.test.ts` check exactly
  that, on a checkout with staged, unstaged and untracked work). The agent's tools cannot reach it
  either: `fs.write`, `fs.delete` and `patch.apply` refuse any path into `.git`, before policy and
  whatever the rules say, and every git tool refuses unless the repository git finds is the run's
  worktree (see *The agent's git tools*; `cli/worktree-escape.test.ts` replays deleting or rewriting the
  worktree's `.git` and then resetting or committing, with no policy file). MAF reads your status with
  `GIT_OPTIONAL_LOCKS=0` so git does not refresh your index. What a run adds to the repository is the
  branch `maf/<runId>`, git's record of the worktree, and the run's state under `.maf/`. A run never
  deletes its worktree or its branch.
- **The run does not see your uncommitted work.** It starts from HEAD and says so when there is
  uncommitted or untracked work.
- **MAF's configuration and state stay in the target directory.** The policy, roles, config, prompts,
  harnesses, memory graph, transcripts, attestations and pending approvals are read and written under
  the target directory's `.maf/`, not the worktree's. In-process tools are confined to the worktree (it is
  their project root), so they cannot reach any of it. `test.run` is not: it runs the project's own test
  command, which can read and write anything the user running MAF can (see *`test.run` executes project code*).
- **Confinement is MAF's, not the operating system's.** A `cli`-tier backend acts with its own tools
  wherever its permission settings let it, inside or outside the worktree, and the worktree shares the
  repository's objects and refs with your checkout.
- **The hand-over.** When the run succeeds, MAF commits what it left uncommitted to `maf/<runId>` —
  through the security diff's pathspec, so no runtime state is added — as `maf <maf@maf.invalid>`,
  unsigned, with hooks off, and prints `git merge maf/<runId>`. It merges nothing. A branch still at its
  base gets no merge command. A branch whose commits bring in runtime state (anything on the D-29 list),
  for example because the agent committed it, is refused: no merge command, the paths named, and the run
  exits non-zero ([D-35](DECISIONS.md)). A failed run keeps its worktree as it was and prints its path.
- **Review the branch before you merge it.** Each writer node's change was reviewed when the node ended,
  but nobody reviews the branch as a whole: work done after a node's review — by a read-only `cli`-tier
  role, which is never reviewed — reaches the branch too.
- **Rollbacks are not on the run path.** `RollbackManager`, which refuses any reset outside a run's
  worktree, is not used by `maf run` in 0.3.0. The coder's own `git.reset` tool can reset `--hard`, and it
  acts on whatever the run works in: in a worktree, the run's branch — and only there, because every git
  tool refuses to run when the repository git finds is not the run's worktree.

With isolation off — `--no-worktree`, or `worktree: false` in `.maf/config.yaml` — the run works in the
target directory itself, on its checked-out branch, after a warning. Then the security gate and any
reviewer see your uncommitted changes as the run's own (`maf run` warns when there are some, and refuses
`--review`), a refused change is left in place with yours, and the coder's `git.commit` and `git.reset`
act on your branch.

### The agent's git tools

The `git.*` tools (`packages/tools/src/plugins/git.ts`) run every git command with
`-c core.hooksPath=/dev/null -c core.fsmonitor= -c commit.gpgsign=false`, which outrank the repository's
own configuration, and with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` set and the
host's `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`/`_KEY_<n>`/`_VALUE_<n>` variables
dropped. So no hook runs — not one in `.git/hooks`, not one an agent wrote under a
relative `core.hooksPath` such as husky's `.husky` — no fsmonitor program runs, no commit is signed, and
the host's git configuration does not apply. `git.commit` uses the repository's own `user.name` and
`user.email` and fills in `maf` / `maf@maf.invalid` only for one the repository leaves unset. Paths are
literal (`GIT_LITERAL_PATHSPECS=1`), and git never prompts.

They act on the run's working tree and nothing else. Before every call, each tool asks git, in the
environment the call will get, which working tree it found (`git rev-parse --show-toplevel`) and refuses
— running nothing — unless that is the project root, symlinks resolved: "the repository git found at
<x> is not the run's working tree <y>". `GIT_CEILING_DIRECTORIES` is set to the root's parent, so a tree
whose `.git` link is gone is no repository at all rather than the user's checkout around it, and the
host's `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and git's other repository-locating variables are
dropped, so MAF started from a git hook does not hand the agent the user's repository. The other half of
the same confinement is in the file tools: `fs.write`, `fs.delete` and `patch.apply` refuse any path
with a `.git` segment at any depth (any case), or that resolves into `.git`, from `declaredPaths` — before
the policy engine is asked — and again when they run, so the agent cannot delete the worktree's `.git`
link or point it at another repository. A refused `.git` path is an error that ends the node, not a policy
verdict, and it is not in the bundle's tool calls. With the tree at a subdirectory of its repository —
MAF pointed at `<repo>/<sub>` — the project root is that subdirectory, so the git tools refuse every call
there.

What this does not cover: repository configuration that names a program still runs it — `diff.external`
or a diff driver's `textconv` on `git.diff`, a filter driver's `clean`/`process` (chosen by an
agent-writable `.gitattributes`) on `git.add`, and `gpg.program` with `log.showSignature` on `git.log`.
`fs.write`, `fs.delete` and `patch.apply` refuse any path into `.git` whatever the policy says, so an
agent cannot add such configuration itself; a relative program path that the repository's configuration
already names is a file the agent can write. MAF's own git calls (`runIsolatedGit`: the security diff, the worktree, the
hand-over) pin `core.hooksPath` and ignore the host's configuration files, but do not pin
`core.fsmonitor`.

### Path confinement

Every path a tool declares for a call is resolved against the project root and proven to lie inside it
before anything acts on it — `resolveInside` (`packages/types/src/paths.ts`). The project root is the
directory the run works in: its worktree, or the target directory with `--no-worktree`. For the `fs.*`
tools the result is the value both the policy engine checks and the tool executes with; for the other
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
