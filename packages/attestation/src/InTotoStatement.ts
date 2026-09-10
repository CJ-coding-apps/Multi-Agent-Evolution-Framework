import type { SlsaBuilder, SlsaInvocation } from '@maf/types';

export interface InTotoSubject {
  name:   string;
  digest: { sha256: string };
}

export interface InTotoStatement {
  _type:         string;
  subject:       InTotoSubject[];
  predicateType: string;
  predicate:     Record<string, unknown>;
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
