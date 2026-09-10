/**
 * GoldenTask — a fixed-task yardstick for harness evolution (plan §5.1).
 * Provenance is REQUIRED (constitution §8 acceptance-lock: no implementation-as-oracle).
 */

export type GoldenProvenance =
  | { source: 'spec';             ref: string }   // cites spec example/amendment
  | { source: 'production-trace'; ref: string }   // cites run_id + attestation bundle sha
  | { source: 'human-decision';   ref: string };  // cites recorded operator decision

export type VerifierRef =
  | { kind: 'test-script';   command: string; args: string[]; expectExit: 0 }
  | { kind: 'security-gate'; maxSeverity: 'low' | 'medium' | 'none' }
  | { kind: 'diff-match';    mustContain: string[]; mustNotContain: string[] }
  | { kind: 'llm-judge';     rubricFile: string };

export interface GoldenTask {
  /** Stable, content-addressed id (sha256 of corpus entry). */
  id: string;
  /** Path (relative to corpus root) of the fixture repo snapshot. */
  repoFixture: string;
  /** Node task description handed to the role. */
  prompt: string;
  /** Which role executes. */
  role: string;
  /** Ordered; all must pass. */
  verifiers: VerifierRef[];
  provenance: GoldenProvenance;
}

export class GoldenCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenCorpusError';
  }
}

const SEVERITIES = new Set(['low', 'medium', 'none']);
const PROVENANCE_SOURCES = new Set(['spec', 'production-trace', 'human-decision']);

export function assertGoldenTask(x: unknown, where: string): asserts x is GoldenTask {
  const fail = (msg: string): never => { throw new GoldenCorpusError(`${where}: ${msg}`); };
  if (!x || typeof x !== 'object') fail('must be an object');
  const o = x as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || o['id'].length === 0) fail('id must be a non-empty string');
  if (typeof o['repoFixture'] !== 'string' || o['repoFixture'].includes('..'))
    fail('repoFixture must be a relative path without ..');
  if (typeof o['prompt'] !== 'string' || o['prompt'].length === 0) fail('prompt must be non-empty');
  if (typeof o['role'] !== 'string' || o['role'].length === 0) fail('role must be non-empty');
  if (!Array.isArray(o['verifiers']) || o['verifiers'].length === 0)
    fail('verifiers must be a non-empty array');
  for (const [i, v] of (o['verifiers'] as unknown[]).entries()) {
    const vv = v as Record<string, unknown>;
    if (!vv || typeof vv !== 'object') fail(`verifiers[${i}] must be an object`);
    switch (vv['kind']) {
      case 'test-script':
        if (typeof vv['command'] !== 'string') fail(`verifiers[${i}].command required`);
        if (!Array.isArray(vv['args'])) fail(`verifiers[${i}].args must be an array`);
        if (vv['expectExit'] !== 0) fail(`verifiers[${i}].expectExit must be 0`);
        break;
      case 'security-gate':
        if (typeof vv['maxSeverity'] !== 'string' || !SEVERITIES.has(vv['maxSeverity'] as string))
          fail(`verifiers[${i}].maxSeverity must be one of none|low|medium`);
        break;
      case 'diff-match':
        if (!Array.isArray(vv['mustContain']) || !Array.isArray(vv['mustNotContain']))
          fail(`verifiers[${i}] requires mustContain/mustNotContain arrays`);
        break;
      case 'llm-judge':
        if (typeof vv['rubricFile'] !== 'string') fail(`verifiers[${i}].rubricFile required`);
        break;
      default:
        fail(`verifiers[${i}].kind unknown: ${JSON.stringify(vv['kind'])}`);
    }
  }
  const prov = o['provenance'] as Record<string, unknown> | undefined;
  if (!prov || typeof prov !== 'object')
    throw new GoldenCorpusError(`${where}: provenance is REQUIRED (acceptance-lock: no implementation-as-oracle)`);
  if (typeof prov['source'] !== 'string' || !PROVENANCE_SOURCES.has(prov['source'] as string))
    fail('provenance.source must be spec | production-trace | human-decision');
  if (typeof prov['ref'] !== 'string' || (prov['ref'] as string).length === 0)
    fail('provenance.ref must be a non-empty citation');
}

export function assertGoldenCorpus(x: unknown): asserts x is GoldenTask[] {
  if (!Array.isArray(x)) throw new GoldenCorpusError('corpus must be an array of tasks');
  const seen = new Set<string>();
  for (const [i, t] of x.entries()) {
    assertGoldenTask(t, `corpus[${i}]`);
    const task = t as GoldenTask;
    if (seen.has(task.id)) throw new GoldenCorpusError(`duplicate task id "${task.id}"`);
    seen.add(task.id);
  }
}
