# Security model

What maf checks, what it does not, and where each boundary is drawn. Sections are added as the
boundaries are implemented; anything not written here is not a guarantee.

## The post-coder security gate: what it reads

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

### Two limits, stated rather than implied

**`.gitignore`d files are outside the diff.** `git add -A` respects `.gitignore`, so a `.env`, a
`secrets/` directory, or a build artifact is not staged and not reviewed. This is deliberate — those files
are excluded precisely because they are not the deliverable — but it does mean **the gate's silence about
a file is not evidence that the file was not written.** A `.gitignore`d write is caught by the tool path
check (a policy rule on the path), not by this diff; when the write comes from a CLI-tier agent's own
file tools, it is not visible to maf at all. See the tier boundary below.

**An oversized diff is an error, never a truncated review.** Past 8 MB the runner fails the node rather
than reviewing the part it managed to read. Reviewing a truncated diff would report the cut portion as
reviewed, which is the same fail-open the diff exists to close, reached a third way.

### A missing repository is an error

If there is no usable repository to diff in, the gate fails the node and says how to fix it — it does not
report a clean diff. `git init` with no commits is *not* this case: the empty tree is a valid base, so the
first change in a fresh repository is reviewable.

## The execution-tier boundary

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

## Reporting

Report suspected vulnerabilities to the maintainers rather than opening a public issue.
