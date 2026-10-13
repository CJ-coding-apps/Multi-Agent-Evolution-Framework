import type { SlsaBuilder, SlsaInvocation } from '@maf/types';

export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v0.1';

export interface InTotoSubject {
  name:   string;
  digest: { sha256: string };
}

export interface InTotoStatement<P = Record<string, unknown>> {
  _type:         string;
  subject:       InTotoSubject[];
  predicateType: string;
  predicate:     P;
}

/**
 * An in-toto Statement over `subjects` (name → sha256 hex). Subjects are sorted by name, so the
 * statement — and so its canonical bytes — does not depend on the order they were recorded in,
 * nor on the key order of the record they were drawn from.
 */
export function makeInTotoStatement<P>(
  subjects:      Record<string, string>,
  predicateType: string,
  predicate:     P,
): InTotoStatement<P> {
  return {
    _type:   IN_TOTO_STATEMENT_TYPE,
    subject: Object.entries(subjects)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, sha256]) => ({ name, digest: { sha256 } })),
    predicateType,
    predicate,
  };
}

export function buildInTotoStatement(
  subjectFiles:  Record<string, string>, // filename → sha256
  builder:       SlsaBuilder,
  invocation:    SlsaInvocation,
): string {
  const stmt: InTotoStatement = {
    _type:         'https://in-toto.io/Statement/v0.1',
    subject:       Object.entries(subjectFiles).map(([name, sha256]) => ({ name, digest: { sha256 } })),
    predicateType: 'https://slsa.dev/provenance/v0.2',
    predicate: {
      buildType:  'https://maf.dev/build/v1',
      builder,
      invocation,
      metadata: {
        buildStartedOn:   new Date().toISOString(),
        buildFinishedOn:  new Date().toISOString(),
        completeness:     { parameters: true, environment: false, materials: false },
        reproducible:     false,
      },
    },
  };
  return JSON.stringify(stmt, null, 2);
}

export function parseInTotoStatement(json: string): InTotoStatement {
  return JSON.parse(json) as InTotoStatement;
}
