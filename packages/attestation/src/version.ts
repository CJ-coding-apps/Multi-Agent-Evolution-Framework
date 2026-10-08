import { readFileSync } from 'node:fs';
import path from 'node:path';

let cached: string | undefined;

/**
 * The version this code shipped as, read from the package rather than written down — a literal
 * is how component ids stayed at `@0.1.0` through two releases. Every @maf package is released
 * under one version, so this package's is the framework's. Read on first use, so an unreadable
 * `package.json` fails the caller that wanted a version, not every import of the package.
 */
export function mafVersion(): string {
  if (cached !== undefined) return cached;
  // dist/version.js → ../package.json, which is where it sits in the published package too.
  const file = path.join(__dirname, '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const version: unknown = parsed !== null && typeof parsed === 'object'
    ? (parsed as { version?: unknown }).version
    : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`Expected a non-empty "version" string in ${file}, found ${JSON.stringify(version)}.`);
  }
  cached = version;
  return version;
}

/** `name@<version>`: the id a builder or component goes by in an attestation. */
export function componentId(name: string): string {
  return `${name}@${mafVersion()}`;
}
