import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, AssistantTurn,
  ToolInput, ToolPlugin, TurnAdapter, TurnMessage,
} from '@maf/types';
import { refusePrototypeKey } from '@maf/types';
import type { GoldenTask } from './GoldenTask.js';
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
  /**
   * When set, this variant applies only if the system prompt (the role prompt, in a gated run)
   * contains this text. Two scripts may then answer the same task prompt differently, which is how
   * an evolved role prompt is shown to change the model's answer with no model in the loop.
   */
  systemContains?: string;
  steps:  ScriptedStep[];
  /** The final assistant text, after the last step. */
  final:  string;
}

/**
 * Answers to the evolution loop's own calls (D-57 offline rows). The loop asks the planner once per
 * round and the critic once per candidate; the scripted adapter answers in order and repeats its
 * last answer once the list is spent, so a run of any length is a pure function of this file.
 */
export interface ScriptedEvolution {
  planner: string[];
  critic:  string[];
}

/** How the scripted adapter recognises the evolver's two system prompts without importing it. */
const PLANNER_PROMPT_PREFIX = 'You are the MAF harness evolution planner.';
const CRITIC_PROMPT_PREFIX  = 'You are the MAF harness evolution critic.';

/** One call the adapter answered, kept so a caller can see what the model was shown. */
export interface ScriptedExchange {
  via:  'turn' | 'invoke';
  kind: 'task' | 'security-review' | 'judge' | 'planner' | 'critic';
  systemPrompt: string;
  /** The task prompt (on a turn, the first user message), or the invoke prompt. */
  prompt: string;
  /**
   * The text this call answered with. The adapter builds no `modelSurface` of its own, so a caller
   * matching surfaces to calls (L1) reads the output here and hashes it itself.
   */
  output?: string;
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
  private readonly scripts = new Map<string, ScriptedTask[]>();
  private readonly evolution: ScriptedEvolution | undefined;

  constructor(tasks: readonly ScriptedTask[] = [], evolution?: ScriptedEvolution) {
    for (const t of tasks) {
      const variants = this.scripts.get(t.prompt) ?? [];
      if (variants.some((v) => v.systemContains === t.systemContains)) {
        throw new Error(`scripted adapter: two scripts answer the same prompt ${JSON.stringify(t.prompt)}`
          + `${t.systemContains === undefined ? '' : ` for the same system-prompt marker ${JSON.stringify(t.systemContains)}`}; each needs exactly one.`);
      }
      variants.push(t);
      this.scripts.set(t.prompt, variants);
    }
    this.evolution = evolution;
  }

  /** The variant for this call: the one whose marker the system prompt satisfies, if any. */
  private scriptFor(prompt: string, systemPrompt: string): ScriptedTask | undefined {
    const variants = this.scripts.get(prompt);
    if (variants === undefined) return undefined;
    // A marked variant is the specific answer; the unmarked one is the default. The order in the
    // file must not decide this, or adding a variant would change nothing.
    const marked = variants.find((v) => v.systemContains !== undefined && systemPrompt.includes(v.systemContains));
    return marked ?? variants.find((v) => v.systemContains === undefined);
  }

  /** The evolution answer for this call: in order, then the last one repeats. */
  private evolutionAnswer(kind: 'planner' | 'critic'): string {
    const answers = this.evolution?.[kind];
    if (answers === undefined || answers.length === 0) {
      throw new Error(`scripted adapter: this ${kind} call has no script; add an "evolution.${kind}" answer to ${SCRIPTED_FILE}.`);
    }
    return answers.length > 1 ? answers.shift()! : answers[0]!;
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
    const answer = (output: string, success = true): AdapterInvokeResult =>
      ({ success, output, toolCallLog: [], exitCode: success ? 0 : 1, duration: 0 });
    // L1: the exchange is on the record before any effect is applied. The call happened when the
    // model answered; a write it asked for failing (or an escape out of the working dir) is a fact
    // about the tree, not a reason for the call that caused it to vanish from the ledger. `output`
    // is filled in below, so an effect that throws leaves it absent rather than guessed.
    const exchange: ScriptedExchange = {
      via: 'invoke', kind, systemPrompt: o.systemPrompt ?? '', prompt: o.prompt,
      tools: o.tools ?? [],
    };
    this.exchanges.push(exchange);
    let result: AdapterInvokeResult;
    if (kind === 'judge') result = answer(formatJudgeVerdict({ passed: false, rationale: SCRIPTED_JUDGE_RATIONALE }));
    else if (kind === 'security-review') result = answer(SCRIPTED_REVIEW);
    else if (kind === 'planner' || kind === 'critic') result = answer(this.evolutionAnswer(kind));
    else {
      const script = this.scriptFor(o.prompt, o.systemPrompt ?? '');
      if (!script) result = answer(noScript(o.prompt, o.systemPrompt ?? '', this.scripts.has(o.prompt)), false);
      else {
        for (const step of script.steps) {
          if (CLI_EFFECTS.has(step.tool)) await applyEffect(o.workingDir, step);
        }
        result = answer(script.final);
      }
    }
    exchange.output = result.output;
    return result;
  }

  async *stream(o: AdapterInvokeOptions): AsyncGenerator<string> {
    yield (await this.invoke(o)).output;
  }

  async sendTurn(history: TurnMessage[], o: AdapterInvokeOptions): Promise<AssistantTurn> {
    const first = history.find((m) => m.kind === 'user');
    const prompt = first && first.kind === 'user' ? first.text : '';
    const lastTool = [...history].reverse().find((m) => m.kind === 'tool');
    const exchange: ScriptedExchange = {
      via: 'turn', kind: 'task', systemPrompt: o.systemPrompt ?? '', prompt, tools: o.tools ?? [],
      ...(lastTool && lastTool.kind === 'tool' ? { lastToolResult: lastTool.content } : {}),
    };

    const script = this.scriptFor(prompt, o.systemPrompt ?? '');
    if (!script) {
      this.exchanges.push(exchange);
      throw new Error(noScript(prompt, o.systemPrompt ?? '', this.scripts.has(prompt)));
    }
    const taken = history.filter((m) => m.kind === 'assistant').length;
    const step = script.steps[taken];
    const turn: AssistantTurn = step
      ? { text: `step ${taken + 1}`,
          toolCalls: [{ toolUseId: `scripted-${taken + 1}`, toolName: step.tool, input: step.input }] }
      : { text: script.final, toolCalls: [] };
    this.exchanges.push({ ...exchange, output: turn.text });
    return turn;
  }
}

function classify(o: AdapterInvokeOptions): ScriptedExchange['kind'] {
  if (o.systemPrompt === JUDGE_SYSTEM_PROMPT) return 'judge';
  if (SECURITY_REVIEW_RE.test(o.prompt)) return 'security-review';
  if (o.systemPrompt?.startsWith(PLANNER_PROMPT_PREFIX) === true) return 'planner';
  if (o.systemPrompt?.startsWith(CRITIC_PROMPT_PREFIX) === true) return 'critic';
  return 'task';
}

function noScript(prompt: string, systemPrompt: string, promptIsKnown: boolean): string {
  if (promptIsKnown) {
    // The prompt has scripts, but every one of them asks for a system-prompt marker this call's
    // role prompt does not contain. Say what was compared rather than calling the task unknown.
    return `scripted adapter: no script for ${JSON.stringify(prompt.slice(0, 160))} matches this role prompt`
      + ` (${JSON.stringify(systemPrompt.slice(0, 120))}).`;
  }
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

// ─── script files ────────────────────────────────────────────────────────────

/** The file a corpus keeps its scripts in, beside corpus.json. */
export const SCRIPTED_FILE = 'scripted.json';

/**
 * Reads `<corpusRoot>/scripted.json` — `{ version: 1, tasks: { <taskId>: { steps, final } } }` —
 * and returns the scripts keyed by the prompt each task hands the model. Scripts are written
 * per task id because that is what a corpus author knows; the model only ever sees the prompt.
 */
export interface ScriptedBundle {
  tasks: ScriptedTask[];
  /** The loop's own answers, when the corpus scripts an evolution run (D-57 offline rows). */
  evolution?: ScriptedEvolution;
}

export async function loadScriptedBundle(corpusRoot: string, corpus: readonly GoldenTask[]): Promise<ScriptedBundle> {
  const file = path.join(corpusRoot, SCRIPTED_FILE);
  let parsed: unknown;
  try {
    // WP-3.9 G5: a corpus file, read through the shared reviver — a refused key is reported with
    // the file's path, like any other unreadable script file.
    parsed = JSON.parse(await readFile(file, 'utf8'), refusePrototypeKey);
  } catch (err) {
    throw new Error(`The scripted adapter reads its scripts from ${file}, which could not be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fail = (msg: string): never => { throw new Error(`${file}: ${msg}`); };
  const o = parsed as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o['version'] !== 1) fail('expected { "version": 1, "tasks": { ... } }');
  const tasks = (o as Record<string, unknown>)['tasks'];
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) fail('"tasks" must be an object keyed by task id');

  const byId = new Map(corpus.map((t) => [t.id, t]));
  const out: ScriptedTask[] = [];
  for (const [id, raw] of Object.entries(tasks as Record<string, unknown>)) {
    const task = byId.get(id);
    if (!task) fail(`script "${id}" names no task in the corpus`);
    // A task may have several scripts, keyed apart by the role prompt they are written for. The
    // author writes either one object or an array of them (`evolution` offline rows use this).
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      const rawScript = entry as Record<string, unknown> | null;
      if (!rawScript || typeof rawScript !== 'object' || !Array.isArray(rawScript['steps']) || typeof rawScript['final'] !== 'string')
        fail(`script "${id}" needs a "steps" array and a string "final"`);
      const s = rawScript as Record<string, unknown>;
      if (s['systemContains'] !== undefined && (typeof s['systemContains'] !== 'string' || s['systemContains'].length === 0))
        fail(`script "${id}": "systemContains" must be a non-empty string when present`);
      const steps = (s['steps'] as unknown[]).map((st, i): ScriptedStep => {
        const step = st as Record<string, unknown> | null;
        if (!step || typeof step['tool'] !== 'string' || !step['input'] || typeof step['input'] !== 'object' || Array.isArray(step['input']))
          fail(`script "${id}" step ${i} needs a string "tool" and an object "input"`);
        return { tool: (step as { tool: string }).tool, input: (step as { input: ToolInput }).input };
      });
      out.push({
        prompt: (task as GoldenTask).prompt,
        ...(typeof s['systemContains'] === 'string' ? { systemContains: s['systemContains'] } : {}),
        steps, final: s['final'] as string,
      });
    }
  }

  const evo = (o as Record<string, unknown>)['evolution'];
  if (evo === undefined) return { tasks: out };
  if (!evo || typeof evo !== 'object' || Array.isArray(evo)) fail('"evolution" must be an object with "planner" and "critic" answer lists');
  const answers = (name: string): string[] => {
    const list = (evo as Record<string, unknown>)[name];
    if (!Array.isArray(list) || list.length === 0 || list.some((a) => typeof a !== 'string' || a.length === 0))
      fail(`"evolution.${name}" must be a non-empty array of non-empty strings`);
    return list as string[];
  };
  return { tasks: out, evolution: { planner: answers('planner'), critic: answers('critic') } };
}

/** The task scripts alone — `goldens run` and the demo do not drive the evolution loop. */
export async function loadScriptedTasks(corpusRoot: string, corpus: readonly GoldenTask[]): Promise<ScriptedTask[]> {
  return (await loadScriptedBundle(corpusRoot, corpus)).tasks;
}
