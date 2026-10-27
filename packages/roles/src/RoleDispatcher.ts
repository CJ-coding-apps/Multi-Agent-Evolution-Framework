import crypto from 'node:crypto';
import type {
  DagNode, RunId, RetryPolicy, BlackboardValue, CliAdapter, AdapterInvokeOptions,
  AdapterInvokeResult, PartialNodeOutcome, SecurityReviewResult, ApprovalGateHandle, TaskId,
  PolicyDecision, ModelSurfaceRecord, AttributedChange, WriterLockLedger, NodeId,
} from '@maf/types';
import { isTurnAdapter, makeTaskId, NodeFailure, GateRefused, ReviewRefused, TransportError, DEFAULT_RETRY_POLICY } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { Attestor } from '@maf/attestation';
import type { MemoryGraph } from '@maf/memory-graph';
import type { TranscriptLogger } from '@maf/transcript';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { ReviewGate, SecurityReviewGate } from '@maf/git-ops';
import { snapshotDiff, snapshotTree, diffTrees, runIsolatedGit, GIT_EMPTY_TREE } from '@maf/git-ops';
import type { HarnessConfig } from '@maf/harness-config';
import {
  ProcessorPipeline, createDefaultProcessorRegistry, DEFAULT_BUNDLE_REFS, redactCredentials } from '@maf/processors';
import type { ProcessorDeps } from '@maf/processors';
import { InProcessAgentLoop } from '@maf/tool-loop';
import type { InProcessLoopResult } from '@maf/tool-loop';
import type { RoleConfig } from './RoleConfig.js';
import { DEFAULT_MAX_TOOL_ITERATIONS } from './RoleConfig.js';
import type { RoleRegistry } from './RoleRegistry.js';
import { RoleToolRegistry } from './RoleToolRegistry.js';
import { isWriterRole, effectiveTier, requestedTier, expectsToolCalls } from './isWriterRole.js';

export interface RoleDispatcherConfig {
  adapter:        CliAdapter;
  baseTools:      ToolRegistry;
  roles:          RoleRegistry;
  injector:       GraphAwareInjector;
  policy:         PolicyEngine;
  attestor:       Attestor;
  graph:          MemoryGraph;
  transcript:     TranscriptLogger;
  lcmBridge:      BlackboardToLcmAdapter;
  reviewGate?:    ReviewGate;
  securityGate?:  SecurityReviewGate;
  cwd:            string;
  sessionId:      string;
  runId:          RunId;
  modelOverride?: string;
  /** Pinned sampling temperature (e.g. 0 for golden determinism); forwarded to the adapter. */
  temperature?:   number;
  /** Phase 1: the resolved harness for this run (processor bundles live here). */
  harness?:       HarnessConfig;
  /**
   * `--allow-ungoverned`: let a writer role run on the cli tier — because its `execution` says
   * so, or because the adapter cannot run the in-process loop — instead of refusing it (D-01).
   */
  allowUngoverned?: boolean;
  /** Where the ungoverned-run banner goes; `process.stderr` when unset. */
  stderr?:        { write(text: string): unknown };
  /** Asked when the policy escalates an in-process tool call (D-02); absent, Escalate is refused. */
  approvalGate?:  ApprovalGateHandle | undefined;
  /**
   * The scheduler's writer-lock ledger (WP-3.0c, the F7 window), handed to the dispatcher so an
   * in-process reader whose bracket shows a change can ask which writers overlapped its turn, and
   * attribute the change to one whose own gate holds it (F2) instead of failing. Absent — a
   * dispatcher with no scheduler behind it, as `wiring.ts` builds for the goldens and evolve paths,
   * which construct no ledger at all — there is no concurrent writer to attribute to, and the reader
   * change guard keeps its pre-WP-3.0c behaviour: it fails the node and records the diff as a
   * subject. That is fail-closed, not fail-open.
   */
  writerLockLedger?: WriterLockLedger;
}

export interface RoleNodeOutput {
  output: BlackboardValue;
}

const MAX_OUTPUT_BYTES        = 2 * 1024 * 1024;  // 2MB per node response
const MAX_STORED_OUTPUT_CHARS = 64_000;
/** Enough of a failed call's output to show its last error, without pasting a transcript into an error. */
const OUTPUT_TAIL_CHARS       = 500;

/**
 * The end of an adapter's output, credentials masked, quoted so an empty or whitespace-only tail
 * is still visible. Masked because the message lands in the signed bundle and the memory graph,
 * which the transcript scrubber never sees.
 */
function outputTail(output: string): string {
  const masked = redactCredentials(output);
  return JSON.stringify(
    masked.length > OUTPUT_TAIL_CHARS ? `…${masked.slice(-OUTPUT_TAIL_CHARS)}` : masked,
  );
}

/**
 * Whether a CLI-tier result counts as the role having done its work (D-04). Until this, the
 * result's `success` and `exitCode` were never read, so a timeout (exit 124), an expired login or
 * an HTTP error body was stored as the node's output and the node was recorded as succeeded.
 *
 * Empty output is held against writers only. A writer that says nothing is what a CLI that died
 * or was cut off looks like, and accepting it records a coder that did nothing as one that
 * succeeded; a read-only role with nothing to report has changed nothing by saying so.
 */
function cliShortfall(
  role: RoleConfig,
  adapterName: string,
  result: AdapterInvokeResult,
): NodeFailure | TransportError | undefined {
  // A transport failure is not a judgement on the work: the backend timed out, exited without
  // a word, or never started. It is the one kind of shortfall a retry can fix, so it keeps its
  // class (D-06) and carries the exit code and tail the same way a judged failure does.
  if (result.transportError) {
    return new TransportError(
      `adapter "${adapterName}" gave no answer for role "${role.role}": ` +
      `${result.transportError.message} (exit code ${result.exitCode}). ` +
      `Output tail: ${outputTail(result.output)}`,
      { cause: result.transportError },
    );
  }
  if (!result.success) {
    return new NodeFailure(
      'adapter_failed',
      `adapter "${adapterName}" was expected to succeed for role "${role.role}", but it reported ` +
      `failure (exit code ${result.exitCode}). Output tail: ${outputTail(result.output)}`,
      result.exitCode,
    );
  }
  if (isWriterRole(role) && result.output.trim() === '') {
    return new NodeFailure(
      'empty_output',
      `role "${role.role}" holds a write tool, so adapter "${adapterName}" was expected to report ` +
      `what it did, but it returned no output (exit code ${result.exitCode}). ` +
      `Output tail: ${outputTail(result.output)}`,
      result.exitCode,
    );
  }
  return undefined;
}

/**
 * A node that finished with an answer: what D-32 judges, on the tier it ran on. The in-process arm
 * carries the loop's turn count, because `no_work` (D-46) says how many turns the reader had to make
 * a call across — a reader that answered on its first turn never tried, and one that was refused on
 * turn one and answered on turn two did.
 */
type Answer =
  | { readonly tier: 'cli'; readonly result: AdapterInvokeResult }
  | { readonly tier: 'in-process'; readonly finalText: string; readonly turns: number };

/** One policy-denied call the attestor recorded for a task (F10): the tool and the rule that stopped it. */
interface DeniedCall {
  readonly toolId: string;
  readonly ruleId?: string | undefined;
}

/**
 * The rule a refused call names, read from its decision (F8). A `Deny` and an `Indeterminate` carry
 * the id on the decision itself; an `Escalate` carries it on the request the gate was shown. Mirrors
 * the rule id `executeToolGated` records on the refusal, so the message and the bundle agree.
 * `undefined` where the decision names no rule at all — the note renders that as "a rule that
 * recorded no id" rather than dropping the call from the count.
 */
function refusingRuleId(decision: PolicyDecision): string | undefined {
  switch (decision.verdict) {
    case 'Deny':
    case 'Indeterminate': return decision.ruleId;
    case 'Escalate':      return decision.approvalRequest?.policyRuleId;
    default:              return undefined;
  }
}

/**
 * Whether a decision is a policy refusal the `no_change` clause names (F8/R2). A `Deny` and an
 * unapproved `Escalate` are refusals outright; so is an `Indeterminate` the engine reached because
 * it could not evaluate one of its own rules — a write it could not decide on is still a write
 * policy refused, and carries the rule's own id. The one exception is a `builtin:*` id:
 * `builtin:input-schema` is the tool's schema refusing a malformed call before policy was ever
 * asked, so naming it "denied or refused by policy" would be untrue.
 */
function isPolicyRefusal(decision: PolicyDecision): boolean {
  switch (decision.verdict) {
    case 'Deny':
    case 'Escalate':      return true;
    case 'Indeterminate': return !(decision.ruleId?.startsWith('builtin:') ?? false);
    default:              return false;
  }
}

/**
 * F10: the sentence a `no_change` message carries when the node's own attested calls were refused.
 * A writer that fails having changed nothing reads the same whether it lost its nerve or every write
 * it tried was refused; naming the rule tells the two apart, which is the difference between a
 * backend to retry and a policy that is misconfigured. Empty when no call was refused, so the
 * ordinary message is unchanged.
 *
 * At most three are named: a node that made twenty refused calls is saying one thing, and the count
 * carries it. The tail keeps this a summary of the refusal, not a transcript of it.
 *
 * F8(b): the count spans every attempt the node made. A `ToolCallRecord` carries no attempt id
 * (types `ToolCallRecord`), so a retried node's refusals are counted together rather than per
 * attempt — the message describes the node, and the attempts are already told apart in the bundle.
 */
function denyNote(denied: readonly DeniedCall[]): string {
  if (denied.length === 0) return '';
  const shown = denied
    .slice(0, 3)
    .map((call) => `${call.ruleId ?? 'a rule that recorded no id'} (${call.toolId})`)
    .join(', ');
  const verb = denied.length === 1 ? 'tool call was' : 'tool calls were';
  return `; ${denied.length} ${verb} denied or refused by policy: ${shown}${denied.length > 3 ? ', …' : ''}`;
}

/**
 * The rule and tool a policy refusal named (L3), taken from the first refused call the F10 clause
 * lists — the same call the message leads with, so the field and the prose agree. `undefined` when
 * nothing was refused, or when the first refusal is one that named no rule: a machine reader then
 * learns the failure was a refusal only from the clause, exactly as before. Omitted keys stay
 * omitted, so a `no_work` with no refusal carries neither and a deep-equal against `{kind}` holds.
 */
function refusalDetail(denied: readonly DeniedCall[]): { ruleId?: string; toolId?: string } | undefined {
  const first = denied[0];
  if (first === undefined) return undefined;
  return { ...(first.ruleId !== undefined ? { ruleId: first.ruleId } : {}), toolId: first.toolId };
}

/**
 * The reader's answer, quoted for `no_work` (D-46): credentials masked first — the same
 * `redactCredentials` the `no_change` tail gets, because this string reaches the signed bundle, the
 * memory graph and the planner's failure recall, none of which the transcript scrubber sees — then
 * its whitespace collapsed to single spaces so the message stays one line, trimmed, and cut to the
 * first 200 characters so it stays a summary rather than a transcript. The mask is *before* the cut,
 * and that order is load-bearing: a credential straddling character 200 would survive a
 * slice-then-mask as a fragment no format pattern recognises. `JSON.stringify` gives the quotes and
 * escapes any quote inside, so a machine parsing the field gets the same text a reader sees.
 */
function answerExcerpt(text: string): string {
  const masked = redactCredentials(text);
  return JSON.stringify(masked.replace(/\s+/g, ' ').trim().slice(0, 200));
}

/**
 * D-32: a role that expects to change the tree finished with an answer and left no diff against the
 * node's start commit. On the cli tier that is what a backend looks like when its own permission
 * settings refused the edit and it said so. In-process it is a loop that completed after its tool
 * calls failed, or after it made none — survivable since a failed call is answered rather than
 * ending the node (WP-2.18). Read as success either way, `Succeeded` would mean two things.
 */
function noChangeShortfall(
  role: RoleConfig,
  adapterName: string,
  answer: Answer,
  startCommit: string,
  denied: readonly DeniedCall[],
): NodeFailure {
  const expected = `role "${role.role}" expects to change the tree, so`;
  const base = `leave a diff against the node's start commit ${startCommit.slice(0, 12)}`;
  const note = denyNote(denied);
  const detail = refusalDetail(denied);
  if (answer.tier === 'cli') {
    return new NodeFailure(
      'no_change',
      `${expected} adapter "${adapterName}" was expected to ${base}, but it answered ` +
      `(exit code ${answer.result.exitCode}) and changed nothing — a backend running under its own ` +
      `permission settings may have refused the edit. Output tail: ${outputTail(answer.result.output)}${note}`,
      answer.result.exitCode,
      detail,
    );
  }
  return new NodeFailure(
    'no_change',
    `${expected} its in-process loop on adapter "${adapterName}" was expected to ${base}, but the ` +
    `loop completed and changed nothing — every tool call it made, each failed one included, is in the ` +
    `run's attestation. Output tail: ${outputTail(answer.finalText)}${note}`,
    undefined,
    detail,
  );
}

/**
 * D-46(ii): the governed turn says what it has, and a role that did no work has not succeeded.
 *
 * A role that was **not expected to change the tree** — `expectsChange` is not `true`, so `no_change`
 * cannot be its reason — finished with a final answer having made **no executed tool call**: every
 * attested call it made was refused, or it made none at all. The predicate is `expectsChange`, not
 * "holds a write tool" (A2, the 0.4.0 audit): the built-in `tester` holds `test.run`, so the old
 * `isWriterRole` test excused it, and a tester answering "All tests pass" with zero calls succeeded on
 * the exact shape this check exists to catch. Live row 2b of the 3.0c pass is the reader case: an
 * in-process `analyst` with the host's native tools disabled tried `Read`/`Glob`/`Grep` anyway, was
 * refused ("No such tool available"), and gave up — and the run read `Succeeded` off the prose. The
 * record said what happened: zero executed calls, one turn, a refusal. Judged from the record, not the
 * narrative: a call that ran is work, and a refused call is not — it left the tree exactly as it found
 * it. "Ran" is `metadata.refused !== true`, the mark `executeToolGated` sets on every call it did not
 * execute (F4/A2): a `Deny`, an `Escalate` the gate did not approve, an `Indeterminate`, a malformed
 * call. An approved `Escalate` ran, keeps its `Escalate` verdict, and carries no such mark, so it is
 * work.
 *
 * Only a role that does not expect a change is judged this way. One that does (`expectsChange: true`,
 * the built-in `coder`) owes a *change* and fails `no_change` (D-32), which is the only case the
 * registry refuses `expectsToolCalls` for. A role that holds no tool, or opted out with
 * `expectsToolCalls: false`, expects nothing and answers from the prompt by design. The message names
 * the role, that no call was executed, the turns it had to make one across, and its own answer; the F10
 * clause is appended when its calls were refused, so the role that was refused and the one that never
 * tried read differently.
 */
function noWorkShortfall(
  role: RoleConfig,
  answer: Answer,
  denied: readonly DeniedCall[],
): NodeFailure {
  const finalText = answer.tier === 'in-process' ? answer.finalText : answer.result.output;
  const turns = answer.tier === 'in-process' ? answer.turns : 1;
  return new NodeFailure(
    'no_work',
    `role "${role.role}" made no executed tool call across ${turns} turn${turns === 1 ? '' : 's'}; ` +
    `its answer: ${answerExcerpt(finalText)}${denyNote(denied)}`,
    undefined,
    refusalDetail(denied),
  );
}

/**
 * F7: a role that holds no write tool changed the tree. `no_change`'s exact mirror — there a role
 * that owed a change made none; here a role that owed none made one.
 *
 * On the cli tier this is the backend acting with file tools of its own. The role's allowlist
 * governs MAF's in-process registry, and on the cli tier MAF hands the backend one prompt and
 * reads back one opaque result: those tools are whatever the backend has, so a "read-only"
 * reviewer can edit a tracked file and the run would otherwise report Succeeded having attested
 * nothing. Detected after the fact, and recorded: the diff becomes a subject of the run's signed
 * statement, so the change is in the evidence even though the node fails.
 *
 * Nothing is reverted here. Under `--no-worktree` (and in the default run, which reads the diff
 * from the same working tree) the tree is the user's own checkout, and MAF does not undo a change
 * it did not make behind the user's back. The message names the files and prints the two commands.
 */
function unexpectedChange(
  role: RoleConfig,
  adapterName: string,
  files: string[],
  cwd: string,
): NodeFailure {
  const named = files.length > 0
    ? `${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`
    : 'at least one file (git named none)';
  return new NodeFailure(
    'unexpected_change',
    `role "${role.role}" holds no write tool, so adapter "${adapterName}" was not expected to ` +
    `change the tree, but it left a diff — ${named}. The change is recorded as a subject of this ` +
    `run's attestation. MAF has not reverted it: inspect it with "git -C ${cwd} diff" and undo it ` +
    `with "git -C ${cwd} checkout -- <path>".`,
  );
}

/**
 * How many files a unified diff changes, counted from its `diff --git` section headers (N4).
 *
 * Counted rather than parsed for paths: git writes the paths into those headers C-quoted, so a
 * non-ASCII name arrives as `"b/caf\303\251.txt"` and every consumer of the *text* would have to
 * undo git's quoting to name the file at all — and a header is not even emitted per path in the
 * ways that matter (a mode-only change has none, and a rename collapses two paths into one section
 * unless rename detection is off). The count is what the rule needs: with `--no-renames` every
 * changed path is exactly one `diff --git` section, so this is the number of paths a correct
 * `--name-only` listing of the same two trees must have, and a disagreement between the two is the
 * signal that the rule cannot name a change it knows exists — the case that must fail closed rather
 * than be excused.
 *
 * Only at column zero of a section header: a *content* line of the file is prefixed with its own
 * `+`/`-`/space, so a line an agent wrote that reads `diff --git …` reaches us as `+diff --git …`
 * or ` diff --git …`, never as a header.
 */
function diffSectionCount(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) count += 1;
  }
  return count;
}

/**
 * sha256, hex, of a diff's text (WP-3.0c). The attribution record carries the digest rather than the
 * diff, matching the bundle's other evidence fields — a reader compares it against the writer's
 * subject without the diff text crossing into a second copy.
 */
function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The security review of one attempt, run at most once whichever route reaches it first: the
 * security-gate processor at task_end, the end of a cli-tier call, or a backend that threw
 * (D-31). It keeps the diff it read, which is also D-32's evidence — one snapshot per attempt.
 */
class AttemptReview {
  private begun = false;
  private seen: string | undefined;

  constructor(private readonly review: (onDiff: (diff: string) => void) => Promise<void>) {}

  /** The diff the review read, once it has read one. */
  get diff(): string | undefined { return this.seen; }

  async run(): Promise<void> {
    if (this.begun) return;
    this.begun = true;
    await this.review((diff) => { this.seen = diff; });
  }
}

/** The in-process counterpart: a loop that ran out of its own budget did not finish (D-04). */
function loopShortfall(role: RoleConfig, loop: InProcessLoopResult): NodeFailure | undefined {
  if (loop.outcome !== 'budget_exhausted') return undefined;
  // The loop names the cause only for maxTurns; a token budget or a processor stopping the
  // loop at step_start leaves `error` unset.
  const cause = loop.error ?? 'the token budget ran out or a processor stopped the loop';
  return new NodeFailure(
    'budget_exhausted',
    `in-process role "${role.role}" was expected to finish, but its loop stopped with ` +
    `budget_exhausted (${cause}). Set allowPartial: true on the node to accept partial work.`,
  );
}

function gitSaid(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * MAF diffs every node's turn (F7): the security gate reads a coder's diff against its start
 * commit, and the `unexpected_change` guard reads a reader's between two working-tree snapshots.
 * Neither can be taken without a repository, and skipping it would attest an unreviewed coder diff
 * as reviewed and let a reader's edit pass as a clean turn. The message has to say what to do about
 * it, because the fix is one command the user can run.
 */
function notARepository(cwd: string, err: unknown): Error {
  return new Error(
    `cannot diff the node's turn — no usable git repository at ${cwd} (git said: ${gitSaid(err)}). ` +
    `Every node is diffed — a writer against its start commit, a reader between two working-tree ` +
    `snapshots, both taken through git — so maf needs a ` +
    `repository to see what the node changed; run "git init" in ${cwd} (or run maf inside an ` +
    `existing repository).`,
  );
}

export class RoleDispatcher {
  constructor(private readonly config: RoleDispatcherConfig) {}

  /**
   * The commit each node first started from, keyed by run and node, held until the node ends.
   * A retry re-enters `runNode`, and a coder that committed on the failed attempt would hand a
   * freshly captured baseline its own change — attempt 2 would diff clean and the gate would
   * call it reviewed (D-06). Only a successful capture is held: one that failed ended its
   * attempt before the node did anything, so the next attempt has nothing to answer for.
   */
  private readonly baselines = new Map<string, string>();

  /**
   * The set of paths each writer node's post-coder gates actually reviewed (WP-3.0c, F2), keyed by
   * node id. A reader whose turn shows a change is excused only for a writer whose reviewed diff
   * carries every path in the reader's bracket — otherwise the change is in no gate's diff, and
   * excusing it is how D-42's "never let a change pass unattested" stops holding. A writer that ran
   * and left an empty diff is recorded as the empty set, so it excuses nothing; a node that never
   * reached the gates has no entry at all.
   */
  private readonly reviewedPaths = new Map<string, Set<string>>();

  /**
   * The tree id each writer node's post-coder gates read, keyed by node id (WP-3.0c, N2). Where
   * `reviewedPaths` says *which paths* a gate judged, this says *what content* it judged, and both
   * are needed because containment by path is not containment by content: a reviewed path can be
   * rewritten after the gate ran, and the reader's bracket would then show a change no gate ever
   * read. A writer answers for a bracket only when its reviewed diff holds every bracket path *and*
   * those paths still carry, in the reader's end tree, the content this tree records — an empty
   * `git diff <gateTree> <endTree> -- <paths>`.
   *
   * Absence is also meaningful: a node with no entry has not run its gate *this attempt* (cleared at
   * each attempt start), which is what tells a writer still holding the lock apart from one whose gate
   * already ran — the first still has a start-commit diff ahead of it that will carry the change, the
   * second must show the change was already the content its gate read.
   */
  private readonly gateTrees = new Map<string, string>();

  /**
   * The node ids this dispatcher started as *writers* (WP-3.0c, N5). Rule (a) names a writer on the
   * strength of the lock alone, so it must be a node that will actually run a gate: a cli-tier
   * *reader* holds the writer lock (the scheduler serializes every cli-tier role, D-01/A3) but never
   * gates, so naming it on the lock would excuse the reader's own change to a node that will never
   * judge it. "Writer" is `isWriterRole`, decided by the tools the role holds (D-07), so a custom
   * writer role is a candidate and a read-only role of any tier is not. Set once per node, where the
   * node starts; a node's role does not change between attempts.
   */
  private readonly writerNodes = new Set<string>();

  /**
   * The writer nodes whose post-coder gate is *in flight* — set the instant the gate starts and
   * before its first read, cleared at each attempt start (WP-3.0c, N5). Rule (a) is true only while
   * the writer's gate has not yet read the tree; without this marker there is a window between the
   * gate's `snapshotTree` and the recording of that tree id in `gateTrees` where a change that
   * landed *after* the read would still be "not yet gated" and so named to the writer — a change
   * its gate will never read. With the marker, rule (a) is false for that window, rule (b) fails
   * closed (no gate tree is recorded yet), and the reader fails rather than passing a change no gate
   * saw. A gate that throws before recording its tree leaves the marker set, so the writer is never
   * named on the lock again this attempt — the fail-closed direction.
   */
  private readonly gating = new Set<string>();

  /**
   * The node has ended, succeeded or failed, and will not be attempted again: forget its
   * baseline. Call it from the scheduler's `onNodeEnd`, which fires once per node after its
   * last attempt; a later run of the same node then starts from wherever the tree is.
   */
  endNode(nodeId: DagNode['id']): void {
    this.baselines.delete(this.baselineKey(nodeId));
  }

  private baselineKey(nodeId: DagNode['id']): string {
    return JSON.stringify([this.config.runId, nodeId]);
  }

  private async baselineFor(nodeId: DagNode['id']): Promise<string> {
    const key = this.baselineKey(nodeId);
    const held = this.baselines.get(key);
    if (held !== undefined) return held;
    const commit = await this.startCommit();
    this.baselines.set(key, commit);
    return commit;
  }

  /**
   * F10: this node's own policy-refused tool calls, read from the run's attestation by the taskId
   * every record carries. Per-node, never the run-wide set — a sibling's refusal is not this node's
   * failure. A test double without the getter answers with no refusals, which leaves the message
   * exactly as it was before this existed.
   *
   * F8(a): a refusal is a `Deny`, an `Escalate` the gate did not approve, or an `Indeterminate` the
   * engine reached because it could not evaluate one of its own rules — every verdict that means
   * "policy refused this call", which the clause's "denied or refused by policy" names. The old
   * `Deny`-only test missed the other two. An `Escalate` the gate *approved* did run and is recorded
   * under its `Escalate` verdict like any other call, so `metadata.refused` — which `executeToolGated`
   * sets on the calls that did not run — is what tells the two apart.
   *
   * R2: the one `Indeterminate` left out is a `builtin:*` one. `builtin:input-schema` is the tool's
   * schema refusing a malformed call before policy was ever asked, so it is not a policy refusal; an
   * engine `Indeterminate` (a `memoryPattern` rule whose graph query threw, or a template naming a
   * parameter that cannot be bound) is policy refusing because it could not decide, and is counted.
   */
  private deniedCallsFor(taskId: TaskId): DeniedCall[] {
    const denied: DeniedCall[] = [];
    for (const call of this.config.attestor.toolCallsForTask?.(taskId) ?? []) {
      const decision = call.policyDecision;
      if (!isPolicyRefusal(decision)) continue;
      if (call.result.metadata.refused !== true) continue;
      const ruleId = refusingRuleId(decision);
      denied.push({
        toolId: String(call.toolId),
        ...(ruleId !== undefined ? { ruleId } : {}),
      });
    }
    return denied;
  }

  /** The ungoverned banner goes out once per dispatcher; `maf run` builds one per run. */
  private bannerShown = false;

  /**
   * How many of this node's attested calls actually ran (D-46): the records whose result was not
   * `refused` — the mark `executeToolGated` sets on every call it did not execute. A `Deny`, an
   * `Escalate` the gate did not approve, an `Indeterminate` and a malformed call are all marked, so
   * none is work; an approved `Escalate` ran and carries no mark, so it is (F4/A2). "Not refused" and
   * not "`Allow`" is the right test: a refusal left the tree exactly as it found it, which is the whole
   * of what the count is for.
   *
   * The count is over the whole node, because a `ToolCallRecord` carries no attempt id (types
   * `ToolCallRecord`). A caller reading it across a retried node must therefore snapshot it when the
   * attempt starts and use the delta (F3/A4), or an earlier attempt's reads would excuse a later
   * attempt that read nothing.
   *
   * In-process by construction: the cli tier records a `modelSurface` per role call but no per-tool
   * `ToolCallRecord`, so on that tier this is always zero — which is why the only check that reads it
   * (`no_work`) is gated to the tier where the record is real.
   */
  private executedCallCount(taskId: TaskId): number {
    let executed = 0;
    for (const call of this.config.attestor.toolCallsForTask?.(taskId) ?? []) {
      if (call.result.metadata.refused !== true) executed += 1;
    }
    return executed;
  }

  /**
   * The tier this node runs on (D-01), decided before it captures anything, spends a model call,
   * or records the tier in the bundle (F7). A writer lands on the cli tier only by its own
   * `execution: 'cli'` or because the adapter cannot run the loop, and then only with
   * `allowUngoverned`: otherwise it is refused here, not run where no gate sees its tool calls.
   * A reader's fallback is not refused — it is the ordinary cli tier for a reader — but it is not
   * harmless either: the backend's own file tools come with it, so a reader that changes the tree
   * is caught after the fact by the node's diff and fails with `unexpected_change` (F7), and the
   * note below is what tells a bundle reader the node landed on the tier its role did not ask for.
   */
  private resolveTier(role: RoleConfig): { tier: 'cli' | 'in-process'; note?: string; ungoverned?: string } {
    const adapter = this.config.adapter;
    const tier = effectiveTier(role, adapter);
    if (tier === 'in-process') return { tier };
    const asked = requestedTier(role);
    if (!isWriterRole(role)) {
      if (asked === 'cli') return { tier };
      return {
        tier,
        note: `[warn] role "${role.role}" requested execution=in-process but adapter "${adapter.name}" lacks the capability; falling back to CLI dispatch`,
      };
    }
    const why = asked === 'cli'
      ? `its execution is set to 'cli'`
      : `adapter "${adapter.name}" cannot run the in-process loop`;
    if (this.config.allowUngoverned !== true) {
      throw new Error(
        `role "${role.role}" holds a write tool, so it was expected to run on the governed ` +
        `in-process tier, but ${why}. Policy verdicts, secret redaction, attested tool calls and ` +
        `processor hooks exist only in-process (D-01), so MAF refuses to start it; pass ` +
        `--allow-ungoverned to run it on the cli tier anyway.`,
      );
    }
    return { tier, ungoverned: why };
  }

  private ungovernedBanner(role: RoleConfig, why: string): void {
    if (this.bannerShown) return;
    this.bannerShown = true;
    (this.config.stderr ?? process.stderr).write(
      `[maf] UNGOVERNED: --allow-ungoverned lets writer role "${role.role}" run on the cli tier ` +
      `(${why}). There MAF applies no policy verdicts, secret redaction, attested tool calls or ` +
      `processor hooks, and reviews only the diff the node leaves. A CLI backend (claude, codex, ` +
      `gemini) edits the tree with its own tools under its own permission settings` +
      `${this.config.adapter.name === 'codex' ? ' — codex is invoked with --full-auto, its sandboxed automatic mode, so it runs its own commands and edits without asking' : ''}; an HTTP ` +
      `backend (ollama, openrouter) has no file tools and cannot change the tree at all, so a role ` +
      `that expects a change fails with no_change there. Shown once per run; the transcript ` +
      `records each ungoverned node.\n`,
    );
  }

  async runNode(node: DagNode): Promise<Record<string, BlackboardValue>> {
    const role = this.config.roles.getRole(node.agentRole);
    const taskId = makeTaskId(node.id);
    // F3/A4: the D-46 guard reads a *count of executed calls*, and a `ToolCallRecord` carries no
    // attempt id, so the number it must read is the delta since this attempt began. Snapshotting here
    // — before the node does anything, and on every attempt — keeps a retry from being a way to
    // succeed having done nothing: a reader that read on attempt 1, hit a transport failure, and then
    // answered without reading on attempt 2 has done no work *this* attempt.
    const executedAtAttemptStart = this.executedCallCount(taskId);
    const resolved = this.resolveTier(role);

    // N2, rule (a): a fresh attempt clears this node's own gate evidence. The gate records what it
    // judged when it runs; clearing here makes `gateTrees.has(id)` mean "gated *this* attempt", so a
    // writer whose gate already ran — the coder's normal path, which holds the lock through transcript
    // append and the LCM flush after its gate — is never mistaken for one whose gate is still ahead of
    // it. A retry re-runs the gate and re-records both, so nothing from the failed attempt can excuse
    // the next one's bracket.
    this.reviewedPaths.delete(node.id);
    this.gateTrees.delete(node.id);
    this.gating.delete(node.id);

    // Captured BEFORE the node does anything, and before any model call is spent. A
    // writer that commits its own work would otherwise diff clean against HEAD, so the
    // security gate would be handed an empty diff and call the change reviewed. Which
    // roles are writers is decided by the tools they hold, not their name (D-07), and
    // the baseline is captured once per node so a retry reviews against the same commit (D-06).
    //
    // Every node captures one, not only the writers (F7): a reader's turn is diffed too, so a
    // role that holds no write tool and changes the tree anyway is caught rather than attested
    // as having done nothing. It costs one `git rev-parse` per node, and a reader one more
    // (`snapshotTree` below).
    const startCommit = await this.baselineFor(node.id);
    const isWriter = isWriterRole(role);
    // N5: rule (a) names a writer on the strength of the lock alone, so it must be a node this
    // dispatcher started as a *writer*. A cli-tier reader holds the writer lock (A3 serializes every
    // cli-tier role) but runs no gate, and naming it would excuse its own change to a node that never
    // judges it. Recorded here, where the node starts; a node's role does not change between attempts.
    if (isWriter) this.writerNodes.add(node.id);
    // F7: a reader is judged on the change *it* made, not on the tree it found. This brackets the
    // reader's turn with two working-tree snapshots and diffs those, so a sibling writer's
    // uncommitted work in the shared worktree — or the user's own dirty checkout under
    // `--no-worktree` — sits in both snapshots and cancels out. Diffing the whole tree against HEAD
    // instead would fail the reader for a change it never made, the false positive this replaces;
    // `snapshotTree` in @maf/git-ops carries the reasoning in full.
    // The bracket's two halves: the tree id the reader's turn starts from, and the instant its turn
    // opens. `at` is read before the snapshot awaits, so the window the ledger is asked about covers
    // the snapshot's own duration too — a writer overlapping *that* shows up here (it may or may not
    // be in the start tree) rather than being charged to the reader. The reading is monotonic
    // (`performance.now()`), like the ledger's own stamps: a wall clock can repeat a millisecond
    // across the two ends of a turn, or step backwards, which is what F4 of the 3.0c review found.
    const readerBracket = isWriter
      ? undefined
      : { at: performance.now(), tree: await snapshotTree(this.config.cwd) };
    const review = isWriter
      ? new AttemptReview((onDiff) => this.runPostCoderGates(node, startCommit, onDiff))
      : undefined;

    // Which tier this node ran on, for the bundle (F7): on the cli tier MAF's policy engine sees
    // no individual tool call, so a rule scoped to a cli-tier role is in force and unreachable,
    // and only the tier the node ran on lets a reader see that. `fellBackFrom` separates "asked
    // for cli" from "asked for in-process and did not get it" (D-06).
    this.config.attestor.recordExecutionTier?.({
      nodeId:  node.id,
      role:    role.role,
      tier:    resolved.tier,
      adapter: this.config.adapter.name,
      ...(resolved.note !== undefined ? { fellBackFrom: 'in-process' as const } : {}),
    });

    await this.config.transcript.append(
      'user',
      `[${role.role}] ${node.label}: ${JSON.stringify(node.metadata)}`,
      { agentRole: role.role, nodeId: node.id },
    );
    if (resolved.note !== undefined) {
      await this.config.transcript.append('system', resolved.note, { agentRole: role.role, nodeId: node.id });
    }
    if (resolved.ungoverned !== undefined) {
      this.ungovernedBanner(role, resolved.ungoverned);
      await this.config.transcript.append(
        'system',
        `[ungoverned] role "${role.role}" runs on the cli tier: ${resolved.ungoverned}; allowed by --allow-ungoverned`,
        { agentRole: role.role, nodeId: node.id },
      );
    }

    const roleTools = new RoleToolRegistry(this.config.baseTools, role.allowedTools);
    const rolePrompt = await this.config.roles.loadPrompt(role);

    // The node whose assembly this is: a summary call made while preparing its prompt is a model
    // call MAF made on this node's behalf, and it is attributed and charged here (WP-3.2 F1). A
    // background compaction with no node passes no trigger and is attributed to the session.
    const assembled = await this.config.injector.assemble(
      node.label, this.config.sessionId, role.role, { taskId, nodeId: node.id },
      // R14: a Dolt cue says "call lcm.expand", and only an in-process turn has MAF's tool registry
      // to call it with. A cli-tier role gets the archive as summaries instead of an instruction it
      // cannot follow.
      { mafToolsAvailable: resolved.tier === 'in-process' },
    );
    const systemPrompt = [assembled.systemPromptPrefix, rolePrompt].filter(Boolean).join('\n');
    // The archive's own transcript lines: the calls it made, and any compaction that could not
    // finish (F1, F5). Written before the node's turn so the call is recorded whether or not the
    // turn that follows it fails.
    for (const call of assembled.lcmSummaryCalls ?? []) {
      await this.config.transcript.append(
        'system',
        `[surface] lcm summary ${call.summaryId} (level ${call.level}, ${call.messages} message(s)): ` +
        `model ${call.model ?? '(unrecorded)'}; system sha256 ${call.systemPromptSha256 ?? '(none)'}; ` +
        `prompt sha256 ${call.promptSha256 ?? '(none)'}; output sha256 ${call.outputSha256 ?? '(none)'}; ` +
        `content tokens ${call.contentTokens}; reported tokens ${call.reportedTokens ?? '(none)'}`,
        { agentRole: role.role, taskId, nodeId: node.id, tier: 'cli', kind: 'lcm-summary',
          summaryId: call.summaryId, level: call.level, messages: call.messages,
          contentTokens: call.contentTokens,
          ...(call.reportedTokens !== undefined ? { reportedTokens: call.reportedTokens } : {}),
          ...(call.model !== undefined ? { model: call.model } : {}),
          ...(call.systemPromptSha256 !== undefined ? { systemPromptSha256: call.systemPromptSha256 } : {}),
          ...(call.promptSha256 !== undefined ? { promptSha256: call.promptSha256 } : {}),
          ...(call.outputSha256 !== undefined ? { outputSha256: call.outputSha256 } : {}) },
      );
    }
    for (const record of assembled.lcmDegraded ?? []) {
      // L3c: a root the archive could not shrink is not a failed compaction — the summaries are
      // intact, and the injector renders cues for that root instead. Say which happened.
      const line = record.reason === 'root-over-budget'
        ? `[lcm] archive root ${record.summaryId ?? '(unknown)'} still exceeds the injector budget ` +
          `(${record.tokens ?? '?'} tokens) after a tighter retry; rendering cues instead`
        : `[lcm] compaction failed: ${record.reason}; continuing uncompacted`;
      await this.config.transcript.append(
        'system',
        line,
        { agentRole: role.role, taskId, nodeId: node.id, kind: 'lcm-degraded',
          reason: record.reason,
          ...(record.summaryId !== undefined ? { summaryId: record.summaryId } : {}),
          ...(record.tokens !== undefined ? { tokens: record.tokens } : {}) },
      );
    }

    const nodeTask = (node.metadata as Record<string, unknown>)['taskDescription'];
    const userPrompt = typeof nodeTask === 'string' && nodeTask ? nodeTask : node.label;

    const invokeOpts: AdapterInvokeOptions = {
      prompt:         userPrompt,
      systemPrompt,
      tools:          roleTools.getAll(),
      workingDir:     this.config.cwd,
      timeoutMs:      role.timeoutMs ?? node.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    const modelChoice = role.model ?? this.config.modelOverride;
    if (modelChoice) invokeOpts.model = modelChoice;
    if (role.tokenBudget) {
      // F1/R5: the summary call was made for this node, so it spends this node's budget. The engine
      // records `tokenBudgetCharged` on every call — the backend's reported count when it gave one,
      // else input plus output — and that is what is subtracted. Recorded always, enforced here,
      // where a budget exists; no built-in role sets one, and D-52 says so.
      const summarySpend = (assembled.lcmSummaryCalls ?? [])
        .reduce((sum, call) => sum + (call.tokenBudgetCharged ?? call.reportedTokens ?? call.contentTokens), 0);
      invokeOpts.tokenBudget = Math.max(0, role.tokenBudget - summarySpend);
    }
    if (this.config.temperature !== undefined) invokeOpts.temperature = this.config.temperature;
    // A reader on the cli tier does not get the backend's write tools (F7). The in-process tier
    // needs nothing here — MAF runs every tool through the registry, and a reader's registry holds
    // no write tool — and this field is read only where an adapter builds its cli-tier argv, so
    // setting it on an in-process turn is inert.
    if (resolved.tier === 'cli' && !isWriter) invokeOpts.nativeTools = 'read-only';

    const adapter = this.config.adapter;
    let outputForMemory: string;
    // Built where the evidence is, thrown only after the transcript has the node's output and
    // the security gate has seen its diff: an agent can change the tree before it fails, and
    // a diff left behind is reviewed whatever the outcome — the in-process tier does the same
    // at task_end, where the gate runs on budget_exhausted too.
    let shortfall: NodeFailure | TransportError | undefined;
    // Set when the node finished with an answer: a cli-tier result, or an in-process loop that
    // completed. A loop that stopped any other way has its own failure, and keeps it.
    let answer: Answer | undefined;
    const ranInProcess = resolved.tier === 'in-process';
    try {
      if (ranInProcess) {
        const loop = await this.runInProcess(role, invokeOpts, taskId, review);
        outputForMemory = loop.finalText.slice(0, MAX_STORED_OUTPUT_CHARS);
        shortfall = loopShortfall(role, loop);
        if (loop.outcome === 'completed') answer = { tier: 'in-process', finalText: loop.finalText, turns: loop.steps };
      } else {
        const cliResult = await adapter.invoke(invokeOpts);
        // The cli-tier call is a model call MAF made, so it belongs in the record (WP-3.0c, D-45):
        // the same evidence shape as F4's governed turn, `tier: 'cli'`. What the dispatcher asked of
        // the backend's own tools goes in with it (F3), because for codex and gemini no argv shows it.
        await this.recordCliSurface(role, taskId, cliResult, invokeOpts.nativeTools);
        outputForMemory = cliResult.output.slice(0, MAX_STORED_OUTPUT_CHARS);
        shortfall = cliShortfall(role, adapter.name, cliResult);
        answer = { tier: 'cli', result: cliResult };
      }
    } catch (err: unknown) {
      // The loop or the adapter threw — a turn timed out, a backend never started. Tools may
      // already have changed the tree, so the diff is reviewed before the failure propagates:
      // a refusal (a verdict) outranks the transport failure, and a clean or empty diff lets
      // the original error through for the scheduler to classify. On the in-process tier the
      // dispatcher has already fired task_end, so this is a no-op unless the bundle has no
      // security-gate processor or a task_end processor ahead of it threw. Not when the error
      // already carries a verdict (GateRefused: the gate has spoken) or comes from a loop that
      // finished its task, task_end review included, and reported failure (NodeFailure).
      const alreadyJudged = err instanceof GateRefused || err instanceof NodeFailure;
      if (review && !alreadyJudged) await review.run();
      // A reader can change the tree before it fails too, and a diff left behind is recorded
      // whatever the outcome. The verdict outranks the transport failure, as it does for a writer.
      if (readerBracket !== undefined && !alreadyJudged) {
        await this.readerChangeGuard(node, role, readerBracket, resolved.tier);
      }
      throw err;
    }

    await this.config.transcript.append('assistant', outputForMemory, { agentRole: role.role, nodeId: node.id });
    await this.config.lcmBridge.flush();

    // Every writer's diff is reviewed, once per attempt. In-process that normally happened at
    // task_end, through the security-gate processor; the cli tier, and an in-process bundle
    // without that processor, get it here. `review` exists exactly when the role is a writer.
    if (review) await review.run();
    // And every reader's diff is checked, for the mirror reason: a reader that changed the tree
    // fails here rather than returning the Succeeded that MAF used to report for it (F7).
    if (readerBracket !== undefined) await this.readerChangeGuard(node, role, readerBracket, resolved.tier);

    // D-32, judged after the gate so that a refusal still wins, and only where nothing else
    // already failed the node: an answer, on either tier, from a role that expects a change, whose
    // diff against the start commit — the one the gate just read — is empty. In-process it was
    // left to the record until WP-2.18 made a run of failed tool calls survivable: a coder whose
    // every write failed, and that then said so, would otherwise succeed with nothing done.
    // Every node has a start commit (F7) and only a writer holds `review`; `expectsChange` itself
    // requires a write tool, so the diff below is always one the gate read.
    const denied = this.deniedCallsFor(taskId);
    if (shortfall === undefined && answer !== undefined && role.expectsChange === true &&
        review?.diff?.trim() === '') {
      shortfall = noChangeShortfall(role, adapter.name, answer, startCommit, denied);
    }
    // D-46(ii): a role that was not expected to change the tree, and made no executed tool call, has
    // not done its work, whatever its prose says. Judged from the record, not the narrative (live row
    // 2b). The predicate is `expectsChange`, not "holds a write tool" (A2, the 0.4.0 audit): the
    // built-in `tester` holds `test.run` — a write tool — so it is a writer, but its job is to run the
    // tests, not to change the code, and it declares no `expectsChange`. Keying on `isWriterRole` left
    // it judged by neither guard, so a tester answering "All tests pass" with zero calls succeeded on
    // the exact shape this check exists to catch. Checked after the writer's `no_change` — the two are
    // disjoint, `expectsChange === true` here and not-true there — and only on the in-process tier,
    // where a per-call `ToolCallRecord` exists at all: the cli tier attests none, so an empty call set
    // there means "unwatched", not "did no work", and a cli-tier node (live row 1) is left exactly as
    // it was. `expectsToolCalls` is the role's own declaration, else its tools: a role with none to
    // call, or one that opted out, expects nothing. The count is this attempt's delta (F3/A4), so a
    // retried node that read only on an earlier attempt does not excuse this one.
    const executedThisAttempt = this.executedCallCount(taskId) - executedAtAttemptStart;
    if (shortfall === undefined && answer?.tier === 'in-process' && role.expectsChange !== true &&
        expectsToolCalls(role) && executedThisAttempt === 0) {
      shortfall = noWorkShortfall(role, answer, denied);
    }

    if (shortfall) {
      // A transport failure is thrown as itself so the scheduler can retry it (D-06). Of the
      // judged failures, only running out of the node's own budget can be accepted, and only
      // by a node that asked for it; an adapter that failed or a writer that said nothing has
      // no partial work to keep.
      if (shortfall instanceof TransportError) throw shortfall;
      if (shortfall.reason !== 'budget_exhausted' || node.allowPartial !== true) throw shortfall;
      await this.config.transcript.append(
        'system',
        `[partial] node "${node.id}" stopped early and allowPartial accepts it: ${shortfall.message}`,
        { agentRole: role.role, nodeId: node.id },
      );
      const partial: PartialNodeOutcome = {
        status: 'partial', reason: shortfall.reason, detail: shortfall.message,
      };
      return {
        output:  { kind: 'string', value: outputForMemory },
        outcome: { kind: 'json', value: partial },
      };
    }

    return { output: { kind: 'string', value: outputForMemory } };
  }

  /**
   * In-process execution: processor pipeline around every turn/tool call, policy
   * gated per call. Processor bundle = harness.processorBundles, or the default
   * bundle when the harness carries none (see DEFAULT_BUNDLE_REFS in @maf/processors).
   */
  private async runInProcess(
    role: ReturnType<RoleRegistry['getRole']>,
    invokeOpts: AdapterInvokeOptions,
    taskId: ReturnType<typeof makeTaskId>,
    review: AttemptReview | undefined,
  ): Promise<InProcessLoopResult> {
    const adapter = this.config.adapter;
    if (!isTurnAdapter(adapter)) throw new Error('unreachable: gated by caller');

    const harness = this.config.harness;
    const harnessSha = harness?.sha ?? '0'.repeat(64);
    const refs = harness && harness.processorBundles.length > 0
      ? harness.processorBundles
      : [...DEFAULT_BUNDLE_REFS];
    const deps: ProcessorDeps = {
      transcript: this.config.transcript,
      // Every writer gets a runner and no reader does: `review` exists exactly for writers.
      ...(review !== undefined ? { securityRunner: () => review.run() } : {}),
    };
    const pipeline = ProcessorPipeline.build(refs, createDefaultProcessorRegistry(), deps);
    // Whether the loop reached task_end, recorded as the event goes in: a task_end processor
    // that throws (the transcript sorts before the gate) has still been handed the end of the task.
    let taskEndEmitted = false;
    const runHook = pipeline.run.bind(pipeline);
    pipeline.run = (event) => {
      if (event.hook === 'task_end') taskEndEmitted = true;
      return runHook(event);
    };

    const toolList = new RoleToolRegistry(this.config.baseTools, role.allowedTools).getAll();
    const loop = new InProcessAgentLoop(
      {
        role:         role.role,
        harnessSha,
        systemPrompt: invokeOpts.systemPrompt ?? '',
        userPrompt:   invokeOpts.prompt,
        tools:        toolList,
        maxTurns:     role.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
        timeoutMs:    invokeOpts.timeoutMs,
        workingDir:   invokeOpts.workingDir,
        projectRoot:  this.config.cwd,
        sessionId:    this.config.sessionId,
        ...(invokeOpts.maxOutputBytes !== undefined ? { maxOutputBytes: invokeOpts.maxOutputBytes } : {}),
        ...(invokeOpts.tokenBudget !== undefined ? { tokenBudget: invokeOpts.tokenBudget } : {}),
        ...(invokeOpts.model !== undefined ? { model: invokeOpts.model } : {}),
      },
      {
        adapter,
        policy:    this.config.policy,
        attestor:  this.config.attestor,
        approvalGate: this.config.approvalGate,
        // Each turn's model surface goes here as well as to the bundle (F4): a reader of the
        // transcript should not have to open the signed artifact to see what the model was shown.
        transcript: this.config.transcript,
        runId:     this.config.runId,
        taskId,
        pipeline,
      },
    );

    let result: InProcessLoopResult;
    try {
      result = await loop.run();
    } catch (err: unknown) {
      // The backend, a processor, or a tool that could not declare its paths threw mid-loop (a tool
      // that fails while running is answered, not thrown), so the loop never reached task_end, where the
      // processors observe the end of the task: the transcript records it, the security gate
      // reviews what the agent left. Fired here instead; a refusal it reaches outranks the
      // original error (D-31). Not when the throw came from task_end itself — a GateRefused, or
      // any processor there failing — since every processor before it already saw the end once.
      // (The loop's step count went with its stack, hence totalSteps 0.)
      if (!taskEndEmitted) {
        await pipeline.run({
          hook: 'task_end', runId: this.config.runId, taskId, role: role.role, harnessSha,
          finalText: '', totalSteps: 0, outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
    // A harness bundle may leave the security-gate processor out; the writer is reviewed anyway.
    await review?.run();
    if (result.outcome === 'failed') {
      throw new NodeFailure('loop_failed', `in-process role "${role.role}" failed: ${result.error ?? 'unknown'}`);
    }
    // budget_exhausted is returned, not thrown: whether it fails the node depends on the node's
    // allowPartial, which the caller decides after the transcript has the output.
    return result;
  }

  /**
   * Records a cli-tier role call's model-facing surface (WP-3.0c, D-45), the cli-tier twin of F4's
   * in-process record: the same shape, `tier: 'cli'`, so "every role call is in the record" is one
   * array rather than two. The adapter assembles it, each from its own argv; an adapter that
   * assembles none — an HTTP backend, which has no argv of its own to report — records nothing
   * rather than an invented surface, exactly as a governed turn with no surface records nothing. A
   * node's cli-tier call is one turn.
   */
  private async recordCliSurface(
    role: RoleConfig,
    taskId: TaskId,
    result: AdapterInvokeResult,
    askedNativeTools: AdapterInvokeOptions['nativeTools'],
  ): Promise<void> {
    const surface = result.modelSurface;
    if (!surface) return;
    const record: ModelSurfaceRecord = {
      role: role.role, taskId, turn: 1, ...surface, tier: 'cli',
      // F3: what the dispatcher asked of the backend's own tools. `undefined` is the default —
      // nothing was asked, and the backend keeps its native tools — and it is recorded as 'full'
      // rather than left out, because codex and gemini pass no flag either way and their argv
      // cannot tell the two apart. It is what was *asked for*: codex ignores `false` and keeps
      // everything, which the reader can see from the adapter it names.
      //
      // N3 (3.0c review): the `'none'` arm is unreachable from a role call. A role call asks
      // `'read-only'` (line above) or nothing at all; `false` is asked only by the planner's and the
      // security reviewer's calls, and neither records a surface. The arm stays for the type's
      // completeness, not because any entry this line writes is ever `'none'`.
      nativeTools: askedNativeTools === false ? 'none' : askedNativeTools === 'read-only' ? 'read-only' : 'full',
    };
    this.config.attestor.recordModelSurface?.(record);
    await this.config.transcript.append(
      'system',
      `[surface] turn ${record.turn}: system sha256 ${record.systemPromptSha256}; ` +
      `prompt sha256 ${record.promptSha256 ?? '(none)'}; output sha256 ${record.outputSha256 ?? '(none)'}; ` +
      `native tools ${record.nativeTools ?? '(unrecorded)'}; argv ${JSON.stringify(record.argv)}`,
      { agentRole: record.role, taskId: record.taskId, turn: record.turn, tier: record.tier,
        systemPromptSha256: record.systemPromptSha256, toolCatalog: record.toolCatalog, argv: record.argv,
        // F7: both digests, so the transcript alone ties the argv's elided markers to what was sent
        // and ties the output to what came back, without the prompt or the output themselves.
        ...(record.promptSha256 !== undefined ? { promptSha256: record.promptSha256 } : {}),
        ...(record.outputSha256 !== undefined ? { outputSha256: record.outputSha256 } : {}),
        ...(record.stdinSha256 !== undefined ? { stdinSha256: record.stdinSha256 } : {}),
        nativeTools: record.nativeTools },
    );
  }

  /**
   * F7: fail a node whose role holds no write tool and whose turn changed the tree. Recorded as a
   * subject of the run's statement before it throws, so the change joins the signed evidence even
   * though the node fails, and `no_change`'s counterpart in the bundle's own terms: the run says
   * what changed, not merely that something did.
   *
   * The test is the tree's own id, taken the same way at the node's start and here, so the two
   * always describe the same content: equal ids mean the turn changed nothing and anything the
   * tree already carried when the turn began — a sibling writer's uncommitted work, the user's own
   * dirty checkout — is not the reader's to answer for. Only a non-equal id is diffed, and that
   * diff is the node's own change. A snapshot that cannot be read is an error, never an empty one:
   * "we could not look" and "nothing changed" must not be the same verdict (A4).
   *
   * A writer running *concurrently* with this reader is the one case the bracket cannot separate:
   * its partial write lands in the end tree with no start-tree counterpart and reads as the
   * reader's. An in-process reader asks the ledger which writers overlapped its turn, and a change
   * is attributed only to one that demonstrably took it to a gate (F2, N2): a writer still holding
   * the lock whose gate has **not yet run this attempt** — its own start-commit diff, the one the
   * security gate is about to read, carries the change — or a writer whose gate **has** run and whose
   * reviewed diff holds *every* path in this bracket **unchanged** since the tree that gate read.
   * Both halves matter: containment by path is not containment by content, and a holder whose gate
   * already ran is judged by the content check rather than named on the lock alone. Naming a writer
   * for a change its gate did not read would excuse the change from every gate at once, which is
   * exactly what D-42's "never let a change pass unattested" forbids; anything the rule cannot settle
   * fails the reader. With no such writer the change is the reader's, and the node fails exactly as
   * before, diff recorded as a subject.
   *
   * A *cli*-tier reader is never excused (F4). It holds the writer lock itself — the scheduler
   * serializes every cli-tier role (D-01/A3) — so no other writer can have been running, and any
   * change the bracket shows is its own. The ledger is therefore not consulted at all on that tier;
   * the `exclude` an earlier draft needed, and the wall-clock comparison it rested on, are gone.
   */
  private async readerChangeGuard(
    node: DagNode,
    role: RoleConfig,
    bracket: { at: number; tree: string },
    tier: 'cli' | 'in-process',
  ): Promise<void> {
    const endTree = await snapshotTree(this.config.cwd);
    if (endTree === bracket.tree) return;
    const diff = await diffTrees(this.config.cwd, bracket.tree, endTree);
    // The moment the reader's turn closed, taken the same way `bracket.at` was and after the end
    // snapshot, so the window covers both snapshots' own durations.
    const endedAt = performance.now();
    // The paths, from git rather than from the diff text (N4): a non-ASCII name, a mode-only change
    // and a pure rename each defeat a `---`/`+++` parse — git C-quotes the first, emits no file
    // lines for the second, and collapses the third into one header — so a parsed set can silently
    // omit a path the diff actually changed, and the omission is what excuses the change. `undefined`
    // means the rule cannot name what changed (git failed, or the section count disagrees) and the
    // reader fails closed below rather than being handed an empty set that matches nothing.
    const { paths, listed } = await this.bracketPaths(bracket.tree, endTree, diff);
    const writer = paths !== undefined && tier === 'in-process'
      ? await this.attributableWriter(node, paths, bracket.at, endedAt, endTree)
      : undefined;
    if (writer !== undefined) {
      // The three tree ids the rule used (N6): the digest below is reproducible from the first two
      // with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git diff --text --no-ext-diff
      // --no-textconv --no-renames <fromTree> <toTree>` (the flags the digest was taken with, R1),
      // and the third names the content the named writer's gate read — absent under rule (a),
      // where the writer had not gated yet.
      const attributed: AttributedChange = {
        nodeId: node.id, attributedTo: writer, diffSha256: sha256Hex(diff),
        fromTree: bracket.tree, toTree: endTree,
        ...(this.gateTrees.get(writer) !== undefined ? { writerGateTree: this.gateTrees.get(writer)! } : {}),
      };
      this.config.attestor.recordAttribution?.(attributed);
      // The bracket diff as a subject of the run's statement, under its own name: `diffSha256` above
      // then names a diff the statement carries a digest for — in `diffHashes`, like every subject —
      // rather than naming a change written down nowhere (F2).
      this.config.attestor.recordDiffHash?.(`${node.id}.attributed.diff`, diff);
      await this.config.transcript.append(
        'system',
        `[attributed] node "${node.id}" showed a change during its turn, and writer "${writer}" took ` +
        `that change to a gate (F7 window): it had reviewed a diff holding every path this turn ` +
        `showed and those paths are unchanged since, or it still held the lock with its gate not yet ` +
        `run, so its own diff will carry them. The change is judged by that writer's own ` +
        `reviewed diff, not charged to this reader.`,
        { agentRole: role.role, nodeId: node.id, attributedTo: writer, diffSha256: attributed.diffSha256,
          fromTree: attributed.fromTree, toTree: attributed.toTree,
          ...(attributed.writerGateTree !== undefined ? { writerGateTree: attributed.writerGateTree } : {}) },
      );
      return;
    }
    this.config.attestor.recordDiffHash?.(`${node.id}.diff`, diff);
    // R5: `paths` is undefined both when git failed (no names to give) and when the section count
    // disagreed — and on a disagreement git named files the rule simply could not reconcile. Pass
    // the raw listing in that case so the message names them instead of saying "git named none".
    throw unexpectedChange(role, this.config.adapter.name, paths ?? listed, this.config.cwd);
  }

  /**
   * The paths the bracket diff changed, from git (N4), or `undefined` when the rule cannot settle
   * them. Both halves come from the same invocation — `git diff --name-only -z --no-renames <from>
   * <to>` — so a name git would C-quote on a `---`/`+++` line arrives raw and the set is complete
   * for a mode-only change and a rename alike. `-z` is NUL separation, which is also what keeps a
   * path with a newline or a quote in it intact.
   *
   * The count is checked against the diff's own `diff --git` sections: with `--no-renames` each
   * changed path is exactly one section, so a disagreement means the diff shows a change the
   * listing does not name — the change the rule cannot attribute and must not excuse. `undefined`
   * there, and a git failure, both fail the reader closed, never open.
   *
   * The raw listing comes back alongside the settled set (R5): on a count disagreement git *did*
   * name files, and the failure message below must name them rather than claim git named none.
   */
  private async bracketPaths(
    from: string,
    to: string,
    diff: string,
  ): Promise<{ paths: string[] | undefined; listed: string[] }> {
    try {
      const listed = await this.nameOnlyPaths(from, to);
      return { paths: diffSectionCount(diff) === listed.length ? listed : undefined, listed };
    } catch {
      return { paths: undefined, listed: [] };
    }
  }

  /**
   * git's own list of the paths that differ between two trees (N4) — `--name-only -z --no-renames`,
   * NUL-separated and unquoted, so a non-ASCII or otherwise special name is returned as the bytes it
   * is on disk and can be handed straight to a `:(top,literal)` pathspec. `--no-renames` so a rename
   * reads as a deletion plus an addition, matching the diff the rule digests. Throws on a git
   * failure; callers decide whether that is a failure or a fail-closed `undefined`.
   */
  private async nameOnlyPaths(from: string, to: string): Promise<string[]> {
    const { stdout } = await runIsolatedGit(
      this.config.cwd,
      ['diff', '--name-only', '-z', '--no-renames', from, to],
      { env: { GIT_LITERAL_PATHSPECS: '0' } },
    );
    return stdout.split('\0').filter((p) => p.length > 0);
  }

  /**
   * Which of the writers that overlapped `[from, to]` can answer for the reader's bracket diff, or
   * none (F2, tightened by N2). Two conditions qualify, and both keep the change inside a gate:
   *
   *  - **(a) A writer this dispatcher started as a writer, still holding the lock, whose gate has
   *    neither begun nor run this attempt.** Its post-coder gates have not read the tree, and its
   *    start-commit diff will, because the change is already in the tree it is about to diff. The
   *    reader cannot wait for it, so it is named on the strength of the lock alone. Three conditions
   *    make that sound and each closes a window (N5). `writerNodes.has` excludes a cli-tier *reader*,
   *    which holds the same lock (A3) but never gates, so naming it would excuse a change no gate
   *    will ever judge. `!gating.has` excludes a writer whose gate has *started* — the marker is set
   *    before the gate's first read, so a change landing between that read and the recording of the
   *    gate tree is not named on the lock. `!gateTrees.has` excludes a writer whose gate has already
   *    run: the coder holds the lock through transcript append and the LCM flush after its gate, so
   *    it is still holding long after it gated, and it must fall through to (b) to show the change
   *    is the content its gate read.
   *  - **(b) A gating or gated writer**, whose reviewed diff holds every path in the bracket *and*
   *    those paths are unchanged between the tree its gate read and the reader's end tree. The content
   *    check is N2 — a reviewed path can be rewritten after the gate, and path containment alone would
   *    excuse the rewrite as reviewed. Both conditions are needed: `reviewedPaths` is a set of names,
   *    and a name later rewritten names a change the gate never judged. A writer that has begun
   *    gating but whose gate tree is not yet recorded has no `gateTrees` entry, so (b) fails closed
   *    until the gate records it — the window (a) no longer covers.
   *
   * (a) is tried first, so a still-holding writer whose gate is ahead of it is named on the lock
   * alone; (b) covers the completed and the already-gated. With two coders overlapping one reader, the
   * writer that names the change is the one whose own gate actually carries those paths — an earlier
   * interval that reviewed nothing names nobody.
   *
   * Anything the rule cannot settle is `undefined`, and the reader fails. A writer that ran and left
   * an empty diff reviewed no paths and answers for nothing; a writer whose gate ran but whose bracket
   * paths changed afterwards carries an unreviewed change and answers for nothing; a change that
   * appeared from outside the scheduler — an editor under `--no-worktree`, a tool that writes outside
   * the gate — has no writer whose diff carries it, and is exactly the change that must not pass
   * unattested. A `git` failure in the check is settled the same way, not treated as "unchanged":
   * failing closed is the whole point of the rule.
   */
  private async attributableWriter(
    node: DagNode,
    paths: string[],
    from: number,
    to: number,
    endTree: string,
  ): Promise<NodeId | undefined> {
    const ledger = this.config.writerLockLedger;
    if (!ledger) return undefined;
    const candidates = ledger.writersOverlapping(from, to).filter((id) => id !== node.id);
    if (paths.length === 0) return undefined;
    for (const id of candidates) {
      if (this.writerNodes.has(id) && ledger.isHolding(id) && !this.gating.has(id) && !this.gateTrees.has(id)) return id;
    }
    for (const id of candidates) {
      if (await this.reviewedHolds(id, paths, endTree)) return id;
    }
    return undefined;
  }

  /**
   * Whether `id`'s own gate already answers for `paths` (N2, rule (b)): it reviewed every one of them,
   * and they still hold, in the reader's end tree, the content its gate tree recorded. Both halves are
   * needed — `reviewedPaths` is a set of *names*, and a name that was later rewritten names a change
   * the gate never judged.
   */
  private async reviewedHolds(id: NodeId, paths: string[], endTree: string): Promise<boolean> {
    const reviewed = this.reviewedPaths.get(id);
    if (reviewed === undefined || !paths.every((p) => reviewed.has(p))) return false;
    const gateTree = this.gateTrees.get(id);
    if (gateTree === undefined) return false;
    return this.unchangedSince(gateTree, endTree, paths);
  }

  /**
   * Whether `paths` carry the same content in `gateTree` and `endTree` — an empty
   * `git diff <gateTree> <endTree> -- <paths>`. Both trees are `snapshotTree` ids taken through the
   * same throwaway index, so they are content-ids of the whole working tree and a path unchanged in
   * both contributes nothing. The pathspec is `:(top,literal)`-anchored because the paths are
   * repository-top-relative (git's `--name-only` yields them so, N4) while `cwd` may be a
   * subdirectory, and the paths came from the agent and may contain glob metacharacters. `--text
   * --no-ext-diff --no-textconv` are there for the reason the other diffs carry them: an
   * agent-written `.gitattributes` must not change how its own change reads. `--no-renames` matches
   * the listing and the bracket diff, so a rename reads the same way on all three and this check's
   * verdict does not depend on the repository's `diff.renames` config (N4). A `git` failure answers
   * `false` — the rule cannot settle it, and settling it as "reviewed" would be the fail-open this
   * closes.
   */
  private async unchangedSince(gateTree: string, endTree: string, paths: string[]): Promise<boolean> {
    try {
      const { stdout } = await runIsolatedGit(
        this.config.cwd,
        ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', gateTree, endTree, '--',
         ...paths.map((p) => `:(top,literal)${p}`)],
        { env: { GIT_LITERAL_PATHSPECS: '0' } },
      );
      return stdout.trim() === '';
    } catch {
      return false;
    }
  }

  /**
   * The commit the node is about to start from. Diffing against HEAD instead would miss
   * everything an agent that commits its own work changed — the gate would be handed an
   * empty diff and would call the change reviewed, which is the same fail-open reached by
   * another route.
   *
   * A repository with no commits yet is fine: the empty tree is a valid diff base, so the
   * first `git init` + first coder change still produces a reviewable diff. Only an
   * actual absence of a repository is an error.
   */
  private async startCommit(): Promise<string> {
    try {
      const { stdout } = await runIsolatedGit(this.config.cwd, ['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch (err: unknown) {
      try {
        await runIsolatedGit(this.config.cwd, ['rev-parse', '--git-dir']);
      } catch {
        throw notARepository(this.config.cwd, err);
      }
      return GIT_EMPTY_TREE;
    }
  }

  private async runPostCoderGates(
    node: DagNode,
    startCommit: string,
    onDiff: (diff: string) => void,
  ): Promise<void> {
    // The CLI run path does not currently create per-task worktrees, so we read the diff
    // from `git` instead of WorktreeManager.harvest. `snapshotDiff` stages the whole
    // working tree into a throwaway index, so a file the coder created without staging it
    // is reviewed like any other change — see packages/git-ops/src/SnapshotDiff.ts.
    // A failure here is an error, never an empty diff: "we could not look" and "nothing
    // changed" must not be the same verdict.
    // N5: this writer's gate has *started*, marked before its first read. Rule (a) names a still-
    // holding writer on the lock alone, and it must stop the instant the gate begins reading — a
    // change landing after the gate's first snapshot is one the gate will not read, so it must not be
    // named on the lock; with the marker set, (a) is false and (b) fails closed until the gate tree is
    // recorded below. The marker is never cleared within an attempt (only at the attempt start in
    // `runNode`), so a gate that throws leaves the writer un-namable-on-the-lock rather than falsely
    // attributable — the fail-closed direction.
    // The line order is load-bearing and pinned by `N5/R3`: `gating.add` must precede the gate's
    // *first read* below (`snapshotTree`) — a marker set after it leaves a window in which a writer
    // that has begun gating is still namable on the lock alone (mutation N5c).
    this.gating.add(node.id);
    // N2: the tree id this gate is about to judge, taken *before* the diff so it is at-or-just-before
    // the content the gate reads. A later change between the two git calls would then show as changed
    // and fail the reader closed, never the reverse. Same `snapshotTree` the reader's end tree uses, so
    // the two are comparable; kept per node beside the paths, for `attributableWriter` rule (b).
    const gateTree = await snapshotTree(this.config.cwd);
    const diff = await snapshotDiff(this.config.cwd, startCommit);
    // Handed back before anything else: an empty diff is also D-32's evidence (no_change).
    onDiff(diff);
    const changed = diff.trim().length > 0;
    // R4 (D-42): the diff becomes a subject of the run's statement *before* the path listing below.
    // The listing is the one git call between here and the security review that can fail, and if it
    // did the node would fail with the change left unrecorded — but D-42 says the change is recorded
    // whether or not the node survives. An empty diff has nothing to record, exactly as before.
    if (changed) this.config.attestor.recordDiffHash?.(`${node.id}.diff`, diff); // a subject of the run's statement (D-13)
    // The paths this gate is about to judge, kept per node (F2), so a reader whose bracket shows a
    // change can ask whether a gated writer already carried it here. Taken from git (N4) between the
    // start commit and the gate tree — the same two trees the digest is reproducible from — rather
    // than parsed out of the diff text, whose `---`/`+++` lines git does not emit for every change.
    // Recorded even when the diff is empty — the empty set answers for nothing, which is what a
    // writer that changed nothing should be able to say.
    let gatePaths: string[];
    try {
      gatePaths = await this.nameOnlyPaths(startCommit, gateTree);
    } catch (err: unknown) {
      // R4: git cannot name what this gate judged. The subject above already carries the change, so
      // record an *empty* reviewed set — an empty set answers for nothing, and rule (b) needs each of
      // the reader's paths in `reviewed`, so every reader fails closed against this writer — then
      // rethrow, so the writer still fails loudly rather than its change going unrecorded.
      this.reviewedPaths.set(node.id, new Set());
      this.gateTrees.set(node.id, gateTree);
      throw err;
    }
    this.reviewedPaths.set(node.id, new Set(gatePaths));
    this.gateTrees.set(node.id, gateTree);
    if (!changed) return;

    const securityGate = this.config.securityGate;
    if (!securityGate) return this.runReviewGate(node, startCommit, diff);

    // A diff over the gate's size cap is refused by a throw, before any model call. It is
    // still this node's verdict, so it is attested and remembered like a blocking finding
    // before it propagates, rather than surfacing only as a crash.
    let secRes: SecurityReviewResult;
    let refusal: GateRefused | undefined;
    try {
      secRes = await securityGate.reviewDiff(diff);
    } catch (err: unknown) {
      if (!(err instanceof GateRefused)) throw err;
      refusal = err;
      secRes = { findings: err.findings, summary: err.message, passed: false };
    }
    this.config.attestor.recordSecurityFindings(node.id, secRes);

    if (!secRes.passed) {
      await this.config.graph.addNode({
        kind:       'Failure',
        label:      `security:${node.id}`,
        properties: {
          nodeId:   node.id,
          findings: JSON.stringify(secRes.findings),
          summary:  secRes.summary,
        },
        runId: this.config.runId,
      });
      // GateRefused rather than a plain Error, so the scheduler can tell a verdict from a
      // transport failure: a retried attempt diffs a tree the first may already have
      // committed, and an empty diff passes (D-06).
      if (refusal) throw refusal;
      const blockingCount = secRes.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
      throw new GateRefused(
        `Security review refused the change from node ${node.id}: ${blockingCount} blocking ` +
        `(critical or high) finding(s).${secRes.summary ? ` ${secRes.summary}` : ''}`,
        secRes.findings,
      );
    }
    // After the security verdict, never instead of it: a refused change has thrown above, so
    // nobody is asked to approve what the gate would not pass.
    await this.runReviewGate(node, startCommit, diff);
  }

  /**
   * The human review of a writer's change, alongside the security gate. Required: the node waits
   * for the decision, and anything but an approval fails it with ReviewRefused, a verdict (D-06).
   * Advisory, the default: the node goes on whatever the decision. Either way the request and
   * its outcome are in the attestation before anything is thrown.
   */
  private async runReviewGate(node: DagNode, startCommit: string, diff: string): Promise<void> {
    const gate = this.config.reviewGate;
    // The harness is the configuration the bundle names for this run, so a harness that requires
    // review does not run with an advisory gate or with none: the bundle would attest a
    // requirement nobody enforced.
    const harness = this.config.harness;
    if (harness?.reviewGate?.required === true && gate?.required !== true) {
      throw new ReviewRefused(
        `Harness "${harness.id}" requires a human review of every writer's change, but ` +
        `${gate ? 'the review gate wired for this run is advisory (required: false)' : 'no review gate is wired for this run'}, ` +
        `so the change from node ${node.id} cannot be approved and is refused. Pass a ReviewGate ` +
        `constructed with required: true as RoleDispatcherConfig.reviewGate.`,
      );
    }
    if (!gate) return;
    const outcome = await gate.review({
      runId: this.config.runId, nodeId: node.id, role: node.agentRole, baseCommit: startCommit, diff,
    });
    this.config.attestor.addApproval(outcome.attestation);
    if (outcome.refusal) throw outcome.refusal;
  }
}

// Re-exported for callers that build DAG nodes inline without the planner; the value itself
// is the one default in @maf/types (D-06).
export const DEFAULT_NODE_RETRY: RetryPolicy = DEFAULT_RETRY_POLICY;
