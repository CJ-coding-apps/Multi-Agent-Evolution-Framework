import crypto from 'node:crypto';
import type {
  ApprovalDecision, CommitHash, NodeId, ReviewAttestation, RunId,
} from '@maf/types';
import { makeCommitHash, ReviewRefused } from '@maf/types';

/** One writer node's change, as the security gate saw it. */
export interface ReviewSubject {
  runId:      RunId;
  nodeId:     NodeId;
  role:       string;
  /** The commit the node started from: the diff's base, not HEAD. */
  baseCommit: string;
  /** The whole diff. The gate takes the diff itself, so it can never be handed a fallback for one that could not be read. */
  diff:       string;
}

/** What the reviewer is asked to decide. */
export interface ReviewRequest {
  /** Fresh for every request; the attestation record carries it. */
  id:          string;
  runId:       RunId;
  nodeId:      NodeId;
  role:        string;
  baseCommit:  CommitHash;
  diff:        string;
  /** sha256 of `diff`, hex — what the decision is recorded against. */
  diffHash:    string;
  /** Whether anything but an approval fails the node, so a reviewer can say so when it asks. */
  required:    boolean;
  requestedAt: Date;
  /** When an unanswered request is decided as `TimedOut`. */
  expiresAt:   Date;
}

/** The reviewer's answer. Anything else it returns is not a decision, and counts as a denial. */
export interface ReviewDecision {
  verdict:  'Approve' | 'Deny';
  /** Who decided. An approval no one can be named for is not accepted. */
  reviewer: string;
  comment?: string;
}

/**
 * Asks for a decision on one request. `signal` aborts when the gate stops waiting, so a prompt can
 * be withdrawn; an answer that arrives after that is ignored.
 */
export type Reviewer = (request: ReviewRequest, signal: AbortSignal) => Promise<ReviewDecision>;

export interface ReviewGateConfig {
  reviewer:   Reviewer;
  /** Default false: the outcome is recorded and the node goes on, whatever the decision. */
  required?:  boolean;
  /** How long to wait for a decision, in milliseconds. Default 10 minutes. */
  timeoutMs?: number;
}

export interface ReviewOutcome {
  request:     ReviewRequest;
  /** `Approved`; `Rejected` (a denial, a reviewer that failed, an answer that is not a decision); or `TimedOut`. */
  decision:    ApprovalDecision;
  /** The record for the attestation bundle, through `Attestor.addApproval`. */
  attestation: ReviewAttestation;
  /** Set when the gate is required and the decision is not an approval: the node's verdict. */
  refusal?:    ReviewRefused;
}

/** A review reads a whole diff, so it gets longer than an approval prompt: the DAG's default node timeout. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** setTimeout's ceiling. A longer delay fires at once, which would deny every review unasked. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** The reviewer of record when nobody decided. */
const NO_ANSWER = '(no answer)';

/**
 * The human review of a writer's change. It asks the injected reviewer and turns whatever comes
 * back — or does not — into a recorded decision; only an approval from a named reviewer counts
 * as one. Whether the node waits on it is the caller's business; whether a non-approval fails the
 * node is `required`'s.
 */
export class ReviewGate {
  readonly required: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly config: ReviewGateConfig) {
    const t = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(t) || t < 1 || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `ReviewGate timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}; ` +
        `got ${String(t)}.`,
      );
    }
    this.timeoutMs = t;
    this.required = config.required ?? false;
  }

  async review(subject: ReviewSubject): Promise<ReviewOutcome> {
    // An unchanged tree is never sent, and a diff that could not be read is an error before
    // this point. An empty one here is a caller substituting "nothing" for one of those, and
    // answering it would record a change nobody saw as reviewed.
    if (!subject.diff.trim()) {
      throw new Error(
        `The review gate was handed an empty diff for node ${subject.nodeId}; it reviews a ` +
        `change or nothing, and an empty diff is neither an approval nor a change to review.`,
      );
    }
    const requestedAt = new Date();
    const request: ReviewRequest = {
      id:          crypto.randomUUID(),
      runId:       subject.runId,
      nodeId:      subject.nodeId,
      role:        subject.role,
      baseCommit:  makeCommitHash(subject.baseCommit),
      diff:        subject.diff,
      diffHash:    crypto.createHash('sha256').update(subject.diff).digest('hex'),
      required:    this.required,
      requestedAt,
      expiresAt:   new Date(requestedAt.getTime() + this.timeoutMs),
    };
    const { decision, reason } = await this.decide(request);
    const outcome: ReviewOutcome = {
      request,
      decision,
      attestation: {
        requestId:  request.id,
        decision,
        commitHash: request.baseCommit,
        diffHash:   request.diffHash,
        intotoStmt: reviewStatement(request, decision),
      },
    };
    if (this.required && decision.status !== 'Approved') {
      outcome.refusal = new ReviewRefused(
        `Human review refused the change from node ${request.nodeId}: ${reason}. The review gate ` +
        `is required for this run, so the change does not complete without an approval.`,
        request.id,
      );
    }
    return outcome;
  }

  /** Never throws for the reviewer's sake: a reviewer that fails has not approved. */
  private async decide(request: ReviewRequest): Promise<{ decision: ApprovalDecision; reason: string }> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<{ expired: true }>((resolve) => {
      timer = setTimeout(() => resolve({ expired: true }), this.timeoutMs);
    });
    // `then` rather than a direct call, so a reviewer that throws synchronously is caught too.
    const answered = Promise.resolve()
      .then(() => this.config.reviewer(request, controller.signal))
      .then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    let settled: { expired: true } | { value: unknown } | { error: unknown };
    try {
      settled = await Promise.race([answered, expired]);
    } finally {
      // Cleared whichever way it went: a pending ten-minute timer would hold the process open.
      clearTimeout(timer);
    }

    const base = { requestId: request.id, decidedAt: new Date() };
    // Nobody decided: the record says why, under a reviewer of record that names no one.
    const undecided = (status: 'TimedOut' | 'Rejected', reason: string) => ({
      decision: { ...base, status, reviewer: NO_ANSWER, comment: `${capitalise(reason)}.` },
      reason,
    });
    if ('expired' in settled) {
      controller.abort();
      return undecided('TimedOut', `no decision arrived within ${this.timeoutMs} ms`);
    }
    if ('error' in settled) {
      return undecided('Rejected', `the reviewer failed before deciding (${describeError(settled.error)})`);
    }
    const answer = asDecision(settled.value);
    if (!answer) {
      return undecided(
        'Rejected',
        `the reviewer's answer was not a decision (expected verdict "Approve" or "Deny" and a ` +
        `non-empty reviewer name), so it counts as a denial`,
      );
    }
    const decision: ApprovalDecision = {
      ...base,
      status:   answer.verdict === 'Approve' ? 'Approved' : 'Rejected',
      reviewer: answer.reviewer,
      ...(answer.comment ? { comment: answer.comment } : {}),
    };
    const reason = answer.verdict === 'Approve'
      ? `${answer.reviewer} approved it`
      : `${answer.reviewer} denied it${answer.comment ? ` (${answer.comment})` : ''}`;
    return { decision, reason };
  }
}

/** Only the exact shape is a decision: a misspelt verdict or a missing name is not "probably yes". */
function asDecision(x: unknown): ReviewDecision | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const verdict = o['verdict'];
  const reviewer = o['reviewer'];
  if (verdict !== 'Approve' && verdict !== 'Deny') return undefined;
  if (typeof reviewer !== 'string' || !reviewer.trim()) return undefined;
  const comment = typeof o['comment'] === 'string' && o['comment'].trim() ? o['comment'] : undefined;
  return { verdict, reviewer, ...(comment !== undefined ? { comment } : {}) };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'an error that cannot be printed'; }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The decision as an in-toto Statement whose subject is the reviewed diff, by digest. */
function reviewStatement(request: ReviewRequest, decision: ApprovalDecision): string {
  return JSON.stringify({
    _type:         'https://in-toto.io/Statement/v0.1',
    subject:       [{ name: `${request.nodeId}.diff`, digest: { sha256: request.diffHash } }],
    predicateType: 'https://maf.dev/review/v1',
    predicate: {
      requestId:   request.id,
      runId:       request.runId,
      nodeId:      request.nodeId,
      role:        request.role,
      baseCommit:  request.baseCommit,
      required:    request.required,
      status:      decision.status,
      reviewer:    decision.reviewer,
      ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
      requestedAt: request.requestedAt.toISOString(),
      decidedAt:   decision.decidedAt.toISOString(),
    },
  });
}
