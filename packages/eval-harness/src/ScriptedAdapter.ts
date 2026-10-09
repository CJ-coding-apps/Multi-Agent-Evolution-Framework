import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AssistantTurn,
  ToolInput, ToolPlugin, TurnAdapter, TurnMessage,
} from '@maf/types';
import { JUDGE_SYSTEM_PROMPT, formatJudgeVerdict } from './judge.js';

/** One tool call the scripted model makes, in order. */
export interface ScriptedStep {
  tool:  string;
  input: ToolInput;
}

/** The scripted model's whole answer to one task prompt. */
export interface ScriptedTask {
  /** Matched exactly against the task prompt the dispatcher hands the model. */
  prompt: string;
  steps:  ScriptedStep[];
  /** The final assistant text, after the last step. */
  final:  string;
}

/** One call the adapter answered, kept so a caller can see what the model was shown. */
export interface ScriptedExchange {
  via:  'turn' | 'invoke';
  kind: 'task' | 'security-review' | 'judge';
  systemPrompt: string;
  /** The task prompt (on a turn, the first user message), or the invoke prompt. */
  prompt: string;
  tools:  readonly ToolPlugin[];
  /** Turn only: the newest tool result in the history — what the model has just seen. */
  lastToolResult?: string;
}

export const SCRIPTED_ADAPTER_NAME = 'scripted';

/** What the scripted judge says to every rubric: it has no way to evaluate one, so it fails closed. */
export const SCRIPTED_JUDGE_RATIONALE =
  'The scripted adapter does not evaluate rubrics, so it passes nothing; judge with a real model.';

const SCRIPTED_REVIEW =
  '```json\n{"findings":[],"summary":"The scripted adapter reports no findings.","passed":true}\n```';

// The two prompts SecurityReviewGate sends (reviewDiff, reviewPaths).
const SECURITY_REVIEW_RE = /^Audit (this diff|these files) for security issues\./;

// Tool calls the scripted model can carry out itself when it is invoked as an opaque CLI
// agent. Everything else (reads, test runs, git) only observes, so replaying it would change
// nothing in the tree.
const CLI_EFFECTS = new Set(['fs.write', 'fs.delete']);

/**
 * A deterministic stand-in for a model (D-14): it answers each task prompt with a fixed
 * script, so a golden run, the in-process demo and CI produce the same result on every machine.
 * No clock, no randomness, no environment — tool-use ids are the step index.
 *
 * On the in-process tier it emits one scripted tool call per turn, chosen by how many turns it
 * has already taken in the history it is handed, and the gated loop executes them. Invoked as
 * an opaque CLI agent it applies the script's writes and deletes itself, as a CLI backend would,
 * so a role produces the same tree on either tier. It recognises the security gate's review
 * prompt (and reports no findings) and the judge prompt (and passes nothing). A task prompt
 * with no script is an error, never an empty answer.
 */
export class ScriptedAdapter implements TurnAdapter {
  readonly name = SCRIPTED_ADAPTER_NAME;
  readonly exchanges: ScriptedExchange[] = [];
  private readonly scripts = new Map<string, ScriptedTask>();

  constructor(tasks: readonly ScriptedTask[] = []) {
    for (const t of tasks) {
      if (this.scripts.has(t.prompt)) {
        throw new Error(`scripted adapter: two scripts answer the same prompt ${JSON.stringify(t.prompt)}; each prompt needs exactly one.`);
      }
      this.scripts.set(t.prompt, t);
    }
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
      inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
    };
  }

  async isAvailable(): Promise<boolean> { return true; }

  async invoke(o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    const kind = classify(o);
    this.exchanges.push({ via: 'invoke', kind, systemPrompt: o.systemPrompt ?? '', prompt: o.prompt, tools: o.tools ?? [] });
    const answer = (output: string, success = true): AdapterInvokeResult =>
      ({ success, output, toolCallLog: [], exitCode: success ? 0 : 1, duration: 0 });
    if (kind === 'judge') return answer(formatJudgeVerdict({ passed: false, rationale: SCRIPTED_JUDGE_RATIONALE }));
    if (kind === 'security-review') return answer(SCRIPTED_REVIEW);

    const script = this.scripts.get(o.prompt);
    if (!script) return answer(noScript(o.prompt), false);
    for (const step of script.steps) {
      if (CLI_EFFECTS.has(step.tool)) await applyEffect(o.workingDir, step);
    }
    return answer(script.final);
  }

  async *stream(o: AdapterInvokeOptions): AsyncGenerator<string> {
    yield (await this.invoke(o)).output;
  }

  async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    const first = history.find((m) => m.kind === 'user');
    const prompt = first && first.kind === 'user' ? first.text : '';
    const lastTool = [...history].reverse().find((m) => m.kind === 'tool');
    this.exchanges.push({
      via: 'turn', kind: 'task', systemPrompt: o.systemPrompt ?? '', prompt, tools: o.tools ?? [],
      ...(lastTool && lastTool.kind === 'tool' ? { lastToolResult: lastTool.content } : {}),
    });

    const script = this.scripts.get(prompt);
    if (!script) throw new Error(noScript(prompt));
    const taken = history.filter((m) => m.kind === 'assistant').length;
    const step = script.steps[taken];
    if (!step) return { text: script.final, toolCalls: [] };
    return {
      text: `step ${taken + 1}`,
      toolCalls: [{ toolUseId: `scripted-${taken + 1}`, toolName: step.tool, input: step.input }],
    };
  }
}

function classify(o: AdapterInvokeOptions): ScriptedExchange['kind'] {
  if (o.systemPrompt === JUDGE_SYSTEM_PROMPT) return 'judge';
  if (SECURITY_REVIEW_RE.test(o.prompt)) return 'security-review';
  return 'task';
}

function noScript(prompt: string): string {
  return `scripted adapter: no script answers the task ${JSON.stringify(prompt.slice(0, 160))}.`;
}

async function applyEffect(workingDir: string, step: ScriptedStep): Promise<void> {
  const rel = step.input['path'];
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`scripted adapter: a ${step.tool} step needs a string path; got ${JSON.stringify(rel)}.`);
  }
  const root = path.resolve(workingDir);
  const target = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !target.startsWith(root + path.sep)) {
    throw new Error(`scripted adapter: ${step.tool} path ${JSON.stringify(rel)} must stay inside the working directory ${root}.`);
  }
  if (step.tool === 'fs.delete') {
    await rm(target, { force: true });
    return;
  }
  const content = step.input['content'];
  if (typeof content !== 'string') {
    throw new Error(`scripted adapter: the fs.write step for ${JSON.stringify(rel)} needs string content.`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
