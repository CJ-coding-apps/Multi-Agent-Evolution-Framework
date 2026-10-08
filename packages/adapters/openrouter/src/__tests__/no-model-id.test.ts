import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// ORACLE (audit P0 #9; WP-1.8, D-25).
//
// "The adapter names no model" is a property of the source, not of one code path: a fallback id
// can come back in any expression, so it is enforced by reading the source. Any string shaped
// like a model id under this package's `src`, outside comments, fails this test. Choosing a model
// is the user's configuration (options, per call, or OPENROUTER_MODEL), never ours.
//
// `__tests__` is excluded, and has to be: this file names the shapes it forbids in order to
// forbid them, and the behaviour tests use made-up ids.

/** From `packages/adapters/openrouter/dist/__tests__/` back to the package's `src`. */
const SRC_DIR = path.resolve(__dirname, '../../src');
const PACKAGE_DIR = path.dirname(SRC_DIR);

/**
 * Common model-id shapes. `llama` is matched only where it is not the tail of `ollama`, so the
 * name of a sibling adapter is not a model; a vendor prefix this misses is a place to extend the
 * rule, not a hole to write around.
 */
const MODEL_ID_SHAPES = /claude-|gpt-|gemini-|(?<!o)llama|mistral|qwen|\bo[13]-/i;

/**
 * A string literal (group 1, kept) or a comment (blanked). Strings are matched first so a `//`
 * inside a URL is not taken for a comment and cannot hide the rest of its line.
 */
const STRING_OR_COMMENT = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** `text` with every comment blanked, keeping its newlines so line numbers still point at the source. */
function withoutComments(text: string): string {
  return text.replace(STRING_OR_COMMENT, (match: string, literal: string | undefined) =>
    literal ?? match.replace(/[^\n]+/g, ' '));
}

/** `line: text` for each line of `text` that holds a model-id shape outside comments. */
function modelIdLines(text: string): string[] {
  return withoutComments(text)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => MODEL_ID_SHAPES.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...await walk(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Every `.ts` file under this package's `src`, excluding tests, as package-relative paths. */
async function sourceFiles(): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const file of await walk(SRC_DIR)) {
    out.push({
      rel: path.relative(PACKAGE_DIR, file).split(path.sep).join('/'),
      text: await readFile(file, 'utf8'),
    });
  }
  return out;
}

test('the scan finds the files it claims to check', async () => {
  // Without this, a broken walk would report "no violations" for an empty list and the rule
  // below would pass vacuously.
  const rels = (await sourceFiles()).map((f) => f.rel);
  assert.ok(rels.includes('src/OpenRouterAdapter.ts'), `walk missed src/OpenRouterAdapter.ts; found ${rels.join(', ')}`);
  assert.ok(!rels.some((r) => r.includes('__tests__')), 'tests must not be scanned: they name the shapes on purpose');
});

test('the rule catches the id this adapter used to pin, but not in a comment or a URL', () => {
  // The defect as it was written, and the two ways a naive scan gets it wrong.
  assert.equal(modelIdLines(`this.defaultModel = opts.model ?? 'anthropic/claude-sonnet-4-6';`).length, 1);
  assert.deepEqual(modelIdLines(`// it used to be 'anthropic/claude-sonnet-4-6'\n/* or gpt-4o */\nconst m = opts.model;`), []);
  assert.deepEqual(modelIdLines(`const u = 'https://openrouter.ai/x'; const m = 'openai/gpt-4o';`),
    ["1: const u = 'https://openrouter.ai/x'; const m = 'openai/gpt-4o';"]);
  // A sibling adapter's name is not a model.
  assert.deepEqual(modelIdLines(`import { OllamaAdapter } from '@maf/adapter-ollama'; const v = 'OLLAMA_MODEL';`), []);
});

test('no model id appears in the adapter source outside comments', async () => {
  const offenders = (await sourceFiles()).flatMap((f) => modelIdLines(f.text).map((l) => `${f.rel}:${l}`));
  assert.deepEqual(offenders, [],
    'the adapter must not choose a model: take it from the options, the call, or OPENROUTER_MODEL, and refuse without one');
});
