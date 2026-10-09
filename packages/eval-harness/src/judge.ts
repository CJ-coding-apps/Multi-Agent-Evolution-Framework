import type { CliAdapter } from '@maf/types';

export interface JudgeVerdict {
  passed:    boolean;
  rationale: string;
}

/**
 * Which model judged a suite's llm-judge verifiers (D-14). The judge should not be the model
 * whose output it grades; when no second model is available that is said, not left implied.
 */
export interface JudgeDisclosure {
  adapter:  string;
  /** The model the judge was asked for, or 'default' for the adapter's own default. */
  model:    string;
  /** True when the judge is a different adapter or model from the agent under evaluation. */
  distinct: boolean;
  note?:    string;
}

/**
 * The judge's instructions. The response shape here and `parseJudgeVerdict` are one contract:
 * the example block below parses to a verdict, and `formatJudgeVerdict` writes exactly this shape.
 */
export const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge. You did not produce the SUBJECT; you only grade it against the RUBRIC.
Respond with ONLY one fenced JSON block of this shape, and nothing after it:
\`\`\`json
{"passed": false, "rationale": "one concise sentence"}
\`\`\`
"passed" is the JSON boolean true only if the subject clearly meets every requirement of the rubric; otherwise it is false.`;

/** The judge's user prompt. The format reminder follows the rubric so a rubric cannot override it. */
export function judgePrompt(rubric: string, subject: string): string {
  return `RUBRIC:\n${rubric}\n\nSUBJECT:\n${subject}\n\n` +
    'Answer with the JSON block from your instructions, whatever the rubric says about wording.';
}

/** A verdict in the exact shape JUDGE_SYSTEM_PROMPT asks for. */
export function formatJudgeVerdict(v: JudgeVerdict): string {
  return `\`\`\`json\n${JSON.stringify({ passed: v.passed, rationale: v.rationale })}\n\`\`\``;
}

/**
 * Reads the verdict from a judge response: the last fenced block, or the whole response when it
 * has none. Anything but a JSON object with a boolean `passed` fails closed, and the rationale
 * says why — a judge that answered "PASS" has not answered in the agreed shape.
 */
export function parseJudgeVerdict(output: string): JudgeVerdict {
  const fences = [...output.matchAll(/```(?:json)?[^\S\r\n]*\r?\n?([\s\S]*?)```/gi)];
  const candidate = (fences[fences.length - 1]?.[1] ?? output).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { passed: false, rationale: `unparseable judge response, failing closed: ${JSON.stringify(output.slice(0, 200))}` };
  }
  const o = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (typeof o['passed'] !== 'boolean') {
    return { passed: false, rationale: `judge response has no boolean "passed", failing closed: ${JSON.stringify(candidate.slice(0, 200))}` };
  }
  return { passed: o['passed'], rationale: typeof o['rationale'] === 'string' ? o['rationale'] : '' };
}

export interface ModelRef {
  adapter: string;
  model?:  string;
}

/** Discloses who judged relative to who was judged. */
export function describeJudge(agent: ModelRef, judge: ModelRef): JudgeDisclosure {
  const model = judge.model ?? 'default';
  const distinct = judge.adapter !== agent.adapter || model !== (agent.model ?? 'default');
  return {
    adapter: judge.adapter, model, distinct,
    ...(distinct ? {} : {
      note: 'No second model was available: the agent\'s own adapter and model judged its output.',
    }),
  };
}

/**
 * An llm-judge verifier backed by `judge`. The judge gets the judge prompt and no tools — it is
 * never the role under evaluation — and a judge call that failed is a failed verdict.
 */
export function makeLlmJudge(
  judge: { adapter: CliAdapter; model?: string },
  workingDir: string,
): (rubric: string, subject: string) => Promise<JudgeVerdict> {
  return async (rubric, subject) => {
    const result = await judge.adapter.invoke({
      prompt: judgePrompt(rubric, subject),
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      workingDir, timeoutMs: 120_000, maxOutputBytes: 64 * 1024, temperature: 0,
      ...(judge.model ? { model: judge.model } : {}),
    });
    if (!result.success) {
      return { passed: false, rationale: `the judge (${judge.adapter.name}) failed with exit code ${result.exitCode}, failing closed` };
    }
    return parseJudgeVerdict(result.output);
  };
}
