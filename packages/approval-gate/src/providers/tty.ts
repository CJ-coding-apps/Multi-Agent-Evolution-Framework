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
/** Each input field is previewed up to this many lines or characters, whichever comes first. */
export const PREVIEW_LINES = 20;
export const PREVIEW_CHARS = 2_000;
// Past this many fields the rest are counted, not shown, so the preview stays bounded however
// many fields a model puts in an input.
const PREVIEW_FIELDS = 8;

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
  // A request waits its turn behind another prompt; its clock starts when it is shown.
  readonly queues = true;
  private readonly reviewer: string;

  constructor(private readonly options: TtyProviderOptions) {
    if (!options.isTTY) {
      throw new Error('The terminal approval provider needs stdin to be a terminal, and it is not; a run without one is headless and must use the headless provider.');
    }
    this.reviewer = options.reviewer ?? `terminal:${osUser()}`;
  }

  ask(pending: PendingApproval, signal: AbortSignal, asking: () => void = () => undefined): Promise<ProviderAnswer> {
    const input = this.options.input;
    const answer = (turns.get(input) ?? Promise.resolve()).then(() => this.prompt(pending, signal, asking));
    turns.set(input, answer.catch(() => undefined));
    return answer;
  }

  private prompt(pending: PendingApproval, signal: AbortSignal, asking: () => void): Promise<ProviderAnswer> {
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
      asking();
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      input.resume();
    });
  }
}

/**
 * Every value is written escaped: paths and input come from the model, and a raw newline or escape
 * sequence in one could redraw the prompt above the line the operator answers.
 */
function promptText(pending: PendingApproval, code: string): string {
  const paths = pending.declaredPaths.length > 0
    ? pending.declaredPaths.map((p) => escaped(p)).join(', ')
    : '(none declared)';
  return [
    '',
    `[maf] approval needed: policy rule ${escaped(String(pending.request.policyRuleId))} escalated a tool call`,
    `  tool:    ${escaped(String(pending.toolId))}`,
    `  paths:   ${paths}`,
    ...inputPreview(pending.input),
    `  request: ${pending.requestId}`,
    `  hash:    sha256:${pending.requestHash}`,
    `Type ${code} to approve this one call. Anything else refuses it, as does no answer within ${Math.ceil(pending.timeoutMs / 1000)} s.`,
    'approve> ',
  ].join('\n');
}

/**
 * The input, as far as an operator can read it in one prompt: each field up to `PREVIEW_LINES`
 * lines or `PREVIEW_CHARS` characters — a string as its lines, anything else as compact JSON — and
 * what is left out counted in bytes. The hash binds all of it, shown or not.
 */
function inputPreview(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return ['  input:', ...fieldLines(undefined, input)];
  const fields = Object.entries(input);
  if (fields.length === 0) return ['  input:   {}'];
  const lines = ['  input:'];
  for (const [key, value] of fields.slice(0, PREVIEW_FIELDS)) lines.push(...fieldLines(key, value));
  const rest = fields.slice(PREVIEW_FIELDS);
  if (rest.length > 0) {
    const bytes = Buffer.byteLength(compactJson(Object.fromEntries(rest)), 'utf8');
    lines.push(`    (${rest.length} more field${rest.length === 1 ? '' : 's'}, ${bytes} bytes, not shown)`);
  }
  return lines;
}

function fieldLines(key: string | undefined, value: unknown): string[] {
  const label = key === undefined ? '   ' : `    ${escaped(clip(key).shown)}:`;
  // A string is shown as its own lines, each a JSON string literal; anything else as one line of
  // compact JSON.
  const isText = typeof value === 'string';
  const { shown, omittedBytes } = clip(isText ? value : compactJson(value));
  const omitted = omittedBytes > 0 ? `(${omittedBytes} more bytes not shown)` : '';
  if (!shown.includes('\n')) {
    const one = isText ? escaped(shown) : inert(shown);
    return [`${label} ${one}${omitted === '' ? '' : ` ${omitted}`}`];
  }
  const rows = shown.split('\n');
  // The newline that ended the last row shown is not a row of its own.
  if (rows[rows.length - 1] === '') rows.pop();
  return [label, ...rows.map((row) => `      ${escaped(row)}`), ...(omitted === '' ? [] : [`      ${omitted}`])];
}

/** The first `PREVIEW_LINES` lines or `PREVIEW_CHARS` characters of `text`, whichever is less. */
function clip(text: string): { shown: string; omittedBytes: number } {
  let shown = text.slice(0, PREVIEW_CHARS);
  // A cut between the halves of a surrogate pair would show half a character.
  if (shown.length < text.length && /[\ud800-\udbff]$/.test(shown)) shown = shown.slice(0, -1);
  let newline = -1;
  for (let n = 0; n < PREVIEW_LINES; n++) {
    newline = shown.indexOf('\n', newline + 1);
    if (newline === -1) break;
  }
  if (newline !== -1) shown = shown.slice(0, newline + 1);
  return { shown, omittedBytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(shown, 'utf8') };
}

function compactJson(value: unknown): string {
  // The gate refuses an input it cannot hash before anyone is asked, so this is a fallback only.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// `JSON.stringify` escapes the C0 controls, quotes and backslashes, but leaves DEL, the C1 controls
// (U+009B is a CSI to some terminals), the line separators and the bidi controls raw — each of
// which can move the cursor or reorder what the operator reads. C0 is listed too, for the text
// that did not come out of `JSON.stringify`.
const TERMINAL_ACTIVE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `text` with every character a terminal acts on written as a `\u` escape. */
function inert(text: string): string {
  return text.replace(TERMINAL_ACTIVE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `text` as a JSON string literal, with nothing in it a terminal acts on. */
function escaped(text: string): string {
  return inert(JSON.stringify(text));
}

function osUser(): string {
  // userInfo throws where the uid has no passwd entry, as in some containers.
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}
