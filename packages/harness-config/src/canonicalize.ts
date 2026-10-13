import crypto from 'node:crypto';
import { canonicalJson } from '@maf/types';
import type { HarnessConfig } from './types.js';

// Moved to @maf/types; re-exported so this package's surface — and every harness sha — is
// unchanged. The attestation does not sign with it (it needs RFC 8785; see canonicalJson's note).
export { canonicalJson };

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
