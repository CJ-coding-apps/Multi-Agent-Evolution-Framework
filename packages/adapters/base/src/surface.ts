import crypto from 'node:crypto';
import type { ModelSurface } from '@maf/types';

/**
 * The model-facing surface of a cli-tier call (WP-3.0c, D-45), one home because three adapters
 * report one. A governed turn's surface lives in `sendTurn` (F4) and is assembled where MAF builds
 * the system block; this is its cli-tier twin, so that a role call is in the record on whichever
 * tier it ran. Kept here rather than copied into each adapter: the digest form and the elision
 * marker are the same bytes in every bundle, and a second home is how they drift.
 */

/** sha256, hex, of `text` as UTF-8 — the digest form every surface field carries. */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * An argv element's payload, replaced by a marker that keeps the flag readable and the text out of
 * the record: `<name: N bytes, sha256 H>`. `name` is the flag, or `prompt` for a bare positional.
 */
export function elided(name: string, value: string): string {
  return `<${name}: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${sha256Hex(value)}>`;
}

/**
 * A cli-tier call's model-facing surface: the digest of the system block and of the single prompt
 * MAF sent, the digest of the output it received, and the backend argv — passed already elided by
 * the adapter, because only that adapter knows its own argv's payload positions. `toolCatalog` is
 * `''`: MAF sends a cli-tier backend no catalogue of its own; the backend's tools are what its argv
 * restricts, and the argv is carried verbatim so that restriction is readable. `stdin` is passed by
 * an adapter that writes its prompt to the child's stdin — codex joins the system block and the
 * prompt into one blob there (F7), so the two part-digests above do not by themselves say what was
 * sent; an adapter with no stdin leaves it undefined and the field is absent.
 */
export function cliModelSurface(
  systemPrompt: string | undefined,
  prompt: string,
  argv: readonly string[],
  output: string,
  stdin?: string,
): ModelSurface {
  return {
    systemPromptSha256: sha256Hex(systemPrompt ?? ''),
    promptSha256:       sha256Hex(prompt),
    toolCatalog:        '',
    outputSha256:       sha256Hex(output),
    ...(stdin !== undefined ? { stdinSha256: sha256Hex(stdin) } : {}),
    argv:               [...argv],
  };
}
