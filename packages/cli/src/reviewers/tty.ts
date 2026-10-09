import os from 'node:os';
import { headlessReason } from '@maf/approval-gate';
import type { Reviewer, ReviewDecision, ReviewRequest } from '@maf/git-ops';

/** The diff is shown up to this many lines or bytes, whichever comes first (D-34). */
export const REVIEW_PREVIEW_LINES = 200;
export const REVIEW_PREVIEW_BYTES = 20 * 1024;
// No answer is longer; a line that is was not typed in answer to this prompt.
const MAX_ANSWER_CHARS = 1024;

export interface TtyReviewerOptions {
  input:     NodeJS.ReadableStream;
  output:    NodeJS.WritableStream;
  /** Recorded as the decision's reviewer. Defaults to `terminal:<os user>`. */
  reviewer?: string;
}

/**
 * Why no one can review at the terminal, or `undefined` when someone can. The approval gate's own
 * test (D-02) — stdin is not a terminal, or MAF_HEADLESS=1 — so the two gates never disagree about
 * whether a run is headless.
 */
export function reviewerUnavailable(isTTY: boolean, env: NodeJS.ProcessEnv): string | undefined {
  return headlessReason({ isTTY }, env);
}

/**
 * The review gate's reviewer at the terminal (D-34). The prompt goes to `output` (stderr): the node,
 * its role, the commit it started from, the diff's hash and the diff itself, bounded. Only a typed
 * `approve` approves; `deny`, anything else, end of input or the gate withdrawing the request
 * (`signal`) is a denial. One prompt at a time: writers are serialized by the scheduler, but a
 * second request still waits for the first answer rather than reading the same line.
 */
export function createTtyReviewer(options: TtyReviewerOptions): Reviewer {
  const name = options.reviewer ?? `terminal:${osUser()}`;
  let turn: Promise<unknown> = Promise.resolve();
  return (request, signal) => {
    const answer = turn.then(() => ask(options, name, request, signal));
    turn = answer.catch(() => undefined);
    return answer;
  };
}

function ask(options: TtyReviewerOptions, name: string, request: ReviewRequest, signal: AbortSignal): Promise<ReviewDecision> {
  const { input, output } = options;
  const deny = (comment: string): ReviewDecision => ({ verdict: 'Deny', reviewer: name, comment });
  // Withdrawn (timed out) while queued behind another prompt: there is no one left to ask.
  if (signal.aborted) return Promise.resolve(deny('the review was withdrawn before it reached the terminal'));
  // Input already at its end gives no 'end' event to wait for: without this, every later review
  // would hold its node for the gate's whole timeout before denying.
  if ('readableEnded' in input && input.readableEnded === true) {
    return Promise.resolve(deny('the terminal closed before an answer'));
  }
  // An answer typed before this prompt was written was not given to this diff: drop it, so an
  // `approve` typed ahead never approves a change the operator has not seen. (A line still in the
  // terminal's own buffer, which Node has not read yet, cannot be told from an answer.)
  while (input.read() !== null) { /* discard */ }

  return new Promise<ReviewDecision>((resolve) => {
    let typed = '';
    const finish = (decision: ReviewDecision): void => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      // Paused so a waiting stdin does not keep the process alive.
      input.pause();
      resolve(decision);
    };
    const onData = (chunk: string | Buffer): void => {
      typed += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = typed.indexOf('\n');
      if (newline === -1) {
        if (typed.length > MAX_ANSWER_CHARS) finish(deny('the answer was longer than "approve" or "deny"'));
        return;
      }
      const line = typed.slice(0, newline).trim().toLowerCase();
      if (line === 'approve') finish({ verdict: 'Approve', reviewer: name, comment: 'approved at the terminal' });
      else if (line === 'deny') finish(deny('denied at the terminal'));
      else finish(deny(`denied at the terminal: ${inert(JSON.stringify(line.slice(0, 64)))} is not "approve"`));
    };
    const onEnd = (): void => finish(deny('the terminal closed before an answer'));
    const onError = (err: Error): void => finish(deny(`reading the terminal failed: ${err.message}`));
    const onAbort = (): void => finish(deny('no answer before the review gate stopped waiting'));

    output.write(reviewPrompt(request));
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    input.resume();
  });
}

/**
 * The prompt for one request. The node id comes from the planner's output and the diff from the
 * agent, so everything interpolated is written with nothing a terminal acts on: a raw escape
 * sequence or carriage return in either could redraw the prompt above the line the operator answers.
 */
export function reviewPrompt(request: ReviewRequest): string {
  const preview = diffPreview(request.diff);
  const omitted = preview.omittedLines > 0 || preview.omittedBytes > 0
    ? [`  (${preview.omittedLines} more line${preview.omittedLines === 1 ? '' : 's'}, ${preview.omittedBytes} bytes, not shown; ` +
       'the decision is recorded against the hash of the whole diff)']
    : [];
  return [
    '',
    `[maf] review needed: node ${inert(JSON.stringify(String(request.nodeId)))} (role ${inert(JSON.stringify(request.role))}) changed the tree`,
    `  base commit: ${inert(String(request.baseCommit))}`,
    `  diff:        sha256:${inert(request.diffHash)}`,
    request.required
      ? '  required:    anything but approve fails the node'
      : '  advisory:    the decision is recorded and the node goes on either way',
    '  --- diff ---',
    ...preview.lines.map((l) => `  ${inert(l, true)}`),
    ...omitted,
    '  --- end of diff ---',
    `Type approve to accept this change, or deny to refuse it. Anything else refuses it, as does no answer by ${request.expiresAt.toISOString()}.`,
    'review> ',
  ].join('\n');
}

/** The first `REVIEW_PREVIEW_LINES` lines or `REVIEW_PREVIEW_BYTES` bytes of `diff`, and what is left out. */
export function diffPreview(diff: string): { lines: string[]; omittedLines: number; omittedBytes: number } {
  const all = diff.split('\n');
  // The newline that ends the last line is not a line of its own.
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const lines: string[] = [];
  let bytes = 0;
  for (const line of all) {
    if (lines.length >= REVIEW_PREVIEW_LINES) break;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > REVIEW_PREVIEW_BYTES) {
      // A first line longer than the whole budget is shown in part rather than not at all.
      if (lines.length === 0) {
        const head = Buffer.from(line, 'utf8').subarray(0, REVIEW_PREVIEW_BYTES - 1).toString('utf8').replace(/\ufffd+$/, '');
        lines.push(head);
        bytes += Buffer.byteLength(head, 'utf8') + 1;
      }
      break;
    }
    lines.push(line);
    bytes += size;
  }
  return {
    lines,
    omittedLines: all.length - lines.length,
    omittedBytes: Math.max(0, Buffer.byteLength(diff, 'utf8') - bytes),
  };
}

// The C0 controls, DEL, the C1 controls (U+009B is a CSI to some terminals), the line separators and
// the bidi controls — each can move the cursor or reorder what the operator reads. A tab in a diff
// line only moves to the next stop, so a diff line keeps its tabs.
const TERMINAL_ACTIVE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function inert(text: string, keepTabs = false): string {
  return text.replace(TERMINAL_ACTIVE, (c) => (keepTabs && c === '\t'
    ? c
    : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

function osUser(): string {
  // userInfo throws where the uid has no passwd entry, as in some containers.
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}
