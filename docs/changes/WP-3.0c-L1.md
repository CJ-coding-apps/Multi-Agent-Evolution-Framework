# WP-3.0c L1 — every model call `maf run` makes is in the record (D-45)

Branch `wp/surfaces-planner-gate` → `wp/phase-3b`. Round 1 built the run's model-surface record;
this round closes the paths that produced no record at all, or a record that said something untrue.

## What this changes

**Two calls that were outside the record are in it.** A run makes more than its role calls: the
planner's call chooses the DAG before any node exists, and the security gate's call judges a node's
diff. D-45 said both were outside, because MAF spawns them itself rather than through a role node;
`docs/SECURITY.md` said the same. Both are recorded now, at the call site, in the same array and the same
shape: `kind: "planner"` (`taskId: planner`) and `kind: "security-gate"` (whose `taskId` is the
reviewed node's, exactly as the dispatcher mints it, so the gate's call joins that node's role
records; a review outside a node names the gate itself). `kind` and `tier` are additive fields on
`ModelSurfaceRecord` — a reader that ignores them reads the record it read before.

**One record per attempt, on every path.** The planner is retried on a transport failure and nodes
are retried (D-06), so one node can be reviewed twice; each attempt is its own record, and a run
that retried reports both. The record is written in a `finally`, so it survives the three endings
that matter: the call answered and judged, the call answered and refused, and the call **threw**. A
throw carries no output to digest, and the record says so rather than saying nothing: `outputSha256`
is **absent** and `error: "thrown"` is set. Absent is not the digest of an empty string — that would
say the model answered with nothing. This holds for a role call on either tier as well as for the
planner and the gate: the call and its record are one `try/finally`, so a backend that times out or
exits non-zero still leaves the turn it took in the record. A record that cannot be *written* is
reported on stderr and changes nothing about the call: it does not replace the call's error, and it
does not turn a returned answer into a failed node.

**A planning failure is attested, not just reported.** When the planning call fails — judged a
failure by the planner, exhausted its transport retries, threw, or the plan it returned is
refused (an unknown `agentRole` names no role the harness has) — the run writes and signs
`<mafDir>/attestations/<runId>.bundle.json` before it reports the error: every planner surface it
made, `outcome.failure.kind: "planning_failed"` (a new `RunFailureKind`; `RunFailureDetail` is
`RunOutcome.failure`), and **no subjects**, because no node existed to name. `maf run` prints the
bundle path and the signature, and `maf attest verify` accepts it. An attestation failure does not
replace the planning error: the original error is what the run reports. A plan the model returned
is a call that answered, so its surface is an ordinary planner record with the plan's digest as
`outputSha256`; the refusal is the run's `planning_failed` failure, not a surface.

**The transcript is a mirror, not a second source.** Every surface — role call, planner, gate — is
appended to the run's transcript as it is recorded (`[surface] planner turn 1: system sha256 …;
prompt sha256 …; output sha256 …; …`), with the same fields in the metadata. An investigator reading
the transcript sees the same calls, in the same order, as the signed bundle.

**What the record says the model saw is the adapter's account, not the call site's.** An adapter
composes its own system block and argv — `claude` prepends the wire protocol and the tool catalogue
to the role prompt and passes them with flags the call site never sees — so a record rebuilt from
the role prompt describes bytes the backend was never sent. Each adapter therefore builds the
surface **before** it spawns, returns it on success, and attaches it to whatever error it throws
(`withModelSurface`, a field on the same `Error`, so a `TransportError` stays one and is still
retried under D-06). The loop, the dispatcher, the planner and the gate record the adapter's
surface when it is on the result or on the error; only an adapter that attached none falls back to
`callModelSurface` — the system-prompt digest, the prompt digest, the answer's digest, `argv: []`,
`toolCatalog: ''` — and that record is marked **`surfaceSource: "fallback"`**, because the role
prompt is not the block a composing backend was sent. `ollama` and `openrouter` attach the surface
of their request (system message plus user message, `argv: []`), so they are in the record without
the marker; `claude` attaches the composed block and its elided argv, `codex` the composed block and
the `stdinSha256` of the blob it wrote, `gemini` its elided argv.

## Scope

This row covers the calls `maf run` makes, and the per-task gate calls `maf goldens` dispatches
through the same stack. It does **not** cover the evolver's proposer and critic, the goldens
llm-judge, or the goldens `securityScore` gate: `evolve` writes no bundle yet, and the evolver is
being rebuilt for 0.6.0. Those move to **WP-3.7**. `SecurityReviewGate`'s comment no longer claims
goldens and evolve reviews are recorded; `README.md` row 25 reads "Every model call `maf run` makes
is in the record" and is marked `unreleased, pending its live row`.

## Fixtures

None. Every assertion is made against an adapter constructed in the test (`ScriptedAdapter`, and a
subclass that queues planner and gate answers), so the tests need no recorded model output.
