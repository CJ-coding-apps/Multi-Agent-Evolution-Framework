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
 * `result.modelSurface`, which carries the real argv — and a surface built here is marked
 * `surfaceSource: 'fallback'` on the record (R3-S1), so an auditor can tell the two apart.
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

/**
 * R3-S1: an error an adapter throws after it composed a call. The surface rides on the error, so a
 * call that never returns still records *what the backend was actually sent* — the system block the
 * adapter built (role prompt, wire protocol, tool catalogue), the argv it spawned with — rather than
 * a digest the call site reconstructs from the role prompt it happens to hold. For a governed
 * `claude` turn those are not the same text, and a record that names the wrong bytes is worse than
 * no record (Constitution §4).
 *
 * A field on the error, not a wrapper class: the dispatcher and the scheduler key on
 * `instanceof TransportError` to decide whether a node may be retried (D-06), and a wrapper would
 * lose the class the thrower chose.
 */
export interface ModelSurfaceCarrier {
  readonly modelSurface: ModelSurface;
}

/** The error, with the surface of the call that failed attached. Same object, same class. */
export function withModelSurface<T extends Error>(err: T, surface: ModelSurface): T & ModelSurfaceCarrier {
  return Object.assign(err, { modelSurface: surface });
}

/**
 * The surface a thrown value carries, when it carries a well-formed one. `undefined` for anything
 * else — a plain `Error`, or a foreign throw whose `modelSurface` is not the shape this record
 * promises — so a caller falls back rather than recording a field it cannot vouch for.
 */
export function attachedModelSurface(err: unknown): ModelSurface | undefined {
  if (typeof err !== 'object' || err === null || !('modelSurface' in err)) return undefined;
  const surface: unknown = err.modelSurface;
  return isModelSurface(surface) ? surface : undefined;
}

function isModelSurface(value: unknown): value is ModelSurface {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
  return typeof o['systemPromptSha256'] === 'string'
    && typeof o['toolCatalog'] === 'string'
    && Array.isArray(o['argv']) && o['argv'].every((a) => typeof a === 'string')
    && optionalString(o['promptSha256'])
    && optionalString(o['stdinSha256'])
    && optionalString(o['outputSha256'])
    && optionalString(o['model']);
}

/** sha256, hex, of `text` as UTF-8 — the digest form every surface field carries. */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
