import crypto from 'node:crypto';
import type { ModelSurface } from './index.js';

/**
 * L1: the surface of a model call whose adapter reported none. The planner and the security gate
 * call `adapter.invoke` directly, and not every adapter builds a surface there — the scripted
 * adapter has no argv to describe, and an HTTP backend has no command line at all. The call site
 * still holds exactly what was sent and what came back, so their digests are the same evidence a
 * reporting adapter carries: which prompt the model was shown and which answer it returned.
 *
 * `output` is optional because a call can end without one (L1-S5): an adapter that throws is still
 * a call MAF made, and `outputSha256` is then absent — never the digest of an empty string, which
 * would say "the model answered with nothing".
 *
 * `argv` is `[]` and `toolCatalog` is `''` rather than invented: this call site did not build or
 * elide a command line, and a `cli`-tier surface that named one it did not see would be worse than
 * one that says nothing. An adapter that *does* report a surface keeps it — the callers prefer
 * `result.modelSurface`, which carries the real argv.
 */
export function callModelSurface(
  systemPrompt: string | undefined,
  prompt: string,
  output?: string,
): ModelSurface {
  return {
    systemPromptSha256: sha256Hex(systemPrompt ?? ''),
    promptSha256:       sha256Hex(prompt),
    toolCatalog:        '',
    ...(output !== undefined ? { outputSha256: sha256Hex(output) } : {}),
    argv:               [],
  };
}

/** sha256, hex, of `text` as UTF-8 — the digest form every surface field carries. */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
