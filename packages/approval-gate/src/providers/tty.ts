import crypto from 'node:crypto';
import os from 'node:os';
import type { ApprovalProvider, PendingApproval, ProviderAnswer } from '../ApprovalGate.js';

export interface TtyProviderOptions {
  input:     NodeJS.ReadableStream;
  output:    NodeJS.WritableStream;
  isTTY:     boolean;
  /** Recorded as the decision's reviewer. Defaults to `terminal:<os user>`. */
  reviewer?: string;
}

/** Hex characters the operator types to approve. */
export const CONFIRMATION_LENGTH = 6;
// No confirmation is longer; a line that is has not been typed in answer to this prompt.
const MAX_ANSWER_CHARS = 1024;

// One prompt at a time per input stream, across providers: two prompts reading one terminal would
// both take the same line, and a run may build more than one gate.
const turns = new WeakMap<NodeJS.ReadableStream, Promise<unknown>>();

/**
 * The code that approves one request: from its id as well as its hash, because two identical calls
 * share a hash, and a code typed twice must not approve the second one unseen.
 */
export function confirmationCode(pending: Pick<PendingApproval, 'requestId' | 'requestHash'>): string {
  return crypto.createHash('sha256').update(`${pending.requestId}\n${pending.requestHash}`).digest('hex')
    .slice(0, CONFIRMATION_LENGTH);
}

/**
 * Asks the operator at the terminal. Approval is typing the request's confirmation code, not `y`:
 * a `y` typed ahead or by reflex cannot know the code, and the code is shown only in this prompt.
 */
export class TtyApprovalProvider implements ApprovalProvider {
  private readonly reviewer: string;

  constructor(private readonly options: TtyProviderOptions) {
    if (!options.isTTY) {
      throw new Error('The terminal approval provider needs stdin to be a terminal, and it is not; a run without one is headless and must use the headless provider.');
    }
    this.reviewer = options.reviewer ?? `terminal:${osUser()}`;
  }

  ask(pending: PendingApproval, signal: AbortSignal): Promise<ProviderAnswer> {
    const input = this.options.input;
    const answer = (turns.get(input) ?? Promise.resolve()).then(() => this.prompt(pending, signal));
    turns.set(input, answer.catch(() => undefined));
    return answer;
  }

  private prompt(pending: PendingApproval, signal: AbortSignal): Promise<ProviderAnswer> {
    const { input, output } = this.options;
    const answer = (approved: boolean, reason: string): ProviderAnswer => ({
      requestId: pending.requestId, requestHash: pending.requestHash, approved, reviewer: this.reviewer, reason,
    });
    // Settled (timed out) while queued behind another prompt: there is no one left to ask.
    if (signal.aborted) return Promise.resolve(answer(false, 'the request was settled before it reached the terminal'));

    const code = confirmationCode(pending);
    return new Promise<ProviderAnswer>((resolve) => {
      let typed = '';
      const finish = (result: ProviderAnswer): void => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        // Paused so a waiting stdin does not keep the process alive. A line typed before the next
        // prompt still reaches it — and refuses it, since that prompt's code was not yet shown.
        input.pause();
        resolve(result);
      };
      const onData = (chunk: string | Buffer): void => {
        typed += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const newline = typed.indexOf('\n');
        if (newline === -1) {
          if (typed.length > MAX_ANSWER_CHARS) finish(answer(false, 'the answer was longer than any confirmation code'));
          return;
        }
        const line = typed.slice(0, newline).trim().toLowerCase();
        finish(line === code
          ? answer(true, 'approved at the terminal')
          : answer(false, line === '' ? 'refused at the terminal' : `refused at the terminal: ${JSON.stringify(line.slice(0, 64))} is not the confirmation code`));
      };
      const onEnd = (): void => finish(answer(false, 'the terminal closed before an answer'));
      const onError = (err: Error): void => finish(answer(false, `reading the terminal failed: ${err.message}`));
      const onAbort = (): void => finish(answer(false, 'no answer before the gate stopped waiting'));

      output.write(promptText(pending, code));
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      input.resume();
    });
  }
}

/**
 * Every value is written through `JSON.stringify`: paths come from the model's input, and a raw
 * newline or escape sequence in one could redraw the prompt above the line the operator answers.
 */
function promptText(pending: PendingApproval, code: string): string {
  const paths = pending.declaredPaths.length > 0
    ? pending.declaredPaths.map((p) => JSON.stringify(p)).join(', ')
    : '(none declared)';
  return [
    '',
    `[maf] approval needed: policy rule ${JSON.stringify(pending.request.policyRuleId)} escalated a tool call`,
    `  tool:    ${JSON.stringify(pending.toolId)}`,
    `  paths:   ${paths}`,
    `  request: ${pending.requestId}`,
    `  hash:    sha256:${pending.requestHash}`,
    `Type ${code} to approve this one call. Anything else refuses it, as does no answer within ${Math.ceil(pending.timeoutMs / 1000)} s.`,
    'approve> ',
  ].join('\n');
}

function osUser(): string {
  // userInfo throws where the uid has no passwd entry, as in some containers.
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}
