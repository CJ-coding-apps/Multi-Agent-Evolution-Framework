import crypto from 'node:crypto';
import type { HarnessConfig } from './types.js';

/**
 * Deterministic serialization: recursively sort object keys, keep array order.
 * Two configs differing only in key insertion order must produce the same sha.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The hashed payload excludes `sha` itself. */
function shaPayload(config: HarnessConfig): object {
  const { sha: _sha, ...rest } = config;
  return rest;
}

export function computeHarnessSha(config: Omit<HarnessConfig, 'sha'> | HarnessConfig): string {
  const payload = 'sha' in config ? shaPayload(config) : config;
  return crypto
    .createHash('sha256')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

/** Mint a fully-formed config from content + metadata. */
export function mintHarnessConfig(
  fields: Omit<HarnessConfig, 'version' | 'sha'>,
): HarnessConfig {
  const base = { ...fields, version: 1 as const };
  return { ...base, sha: computeHarnessSha(base) };
}
