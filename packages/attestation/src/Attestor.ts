import crypto from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  AttestorHandle, ToolCallRecord, AttestationBundle, SlsaProvenance,
  SlsaBuilder, SlsaInvocation, SlsaMaterial, ReviewAttestation,
  RunId, PolicyDecision, SecurityReviewResult, SecurityFindingsRecord, GoldensSection,
  RunOutcome, KeySource,
} from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import { jcs } from './jcs.js';
import { IN_TOTO_STATEMENT_TYPE, makeInTotoStatement } from './InTotoStatement.js';
import type { InTotoStatement, InTotoSubject } from './InTotoStatement.js';

/** The public development key. Anyone can sign with it, which is why a bundle says when it was used. */
export { DEV_SIGNING_KEY } from './devKey.js';
import { DEV_SIGNING_KEY } from './devKey.js';

const SIGNING_KEY_ENV = 'MAF_SIGNING_KEY';

const DEV_KEY_WARNING =
  `[maf] WARNING: ${SIGNING_KEY_ENV} is not set to a secret of your own — attestation bundles from ` +
  `this run are signed with the public development key and can be forged by anyone. Set ` +
  `${SIGNING_KEY_ENV} before treating a bundle as evidence.`;

/**
 * Which key signs (or checks) a bundle. No secret means the public development key; the caller
 * that lets that happen owes the operator a warning, which `Attestor.resolveSigningSecret` gives.
 * `| undefined` so a call site can hand over an environment variable as it is.
 */
export interface SigningOptions {
  secret?: string | undefined;
}

export interface VerifyResult {
  /**
   * True when the signature matched as a 0.2.x bundle's does (custom JSON, signed over
   * insertion-order `JSON.stringify`). A 0.2.0 one carries no `keySource`, so its key is whatever
   * verified it.
   */
  legacy:    boolean;
  /** The signature matches AND the bundle's own `keySource` names the key that checked it. */
  valid:     boolean;
  /** The key this check used. `'dev'` means a valid result is still no evidence of authorship. */
  keySource: KeySource;
}

// An empty secret is no secret (HMAC accepts it, and so does a forger), and a secret equal to the
// published development key is that key whatever variable it came from.
function signingKey(signing: SigningOptions): { secret: string; keySource: KeySource } {
  const secret = signing.secret;
  return secret && secret !== DEV_SIGNING_KEY
    ? { secret, keySource: 'env' }
    : { secret: DEV_SIGNING_KEY, keySource: 'dev' };
}

/** MAF's predicate type: the predicate is the run as a 0.2.x bundle recorded it, less the signature. */
export const MAF_RUN_PREDICATE_TYPE = 'https://maf.dev/attestation/run/v1';

export type RunPredicate = Omit<AttestationBundle, 'signature'>;

/**
 * The bundle a run writes from 0.3.0: an in-toto Statement whose subjects are the diffs the run
 * reviewed, and beside it the signature over the statement's canonical JSON.
 */
export interface SignedRunStatement extends InTotoStatement<RunPredicate> {
  /** HMAC-SHA256, lowercase hex, over the RFC 8785 form (`jcs`) of every other field of this object. */
  signature: string;
}

/** What `verify` reads: a 0.3.0 statement, or a bundle in the 0.2.x layout (see `bundle()`). */
export type AnyBundle = AttestationBundle | SignedRunStatement;

export interface BundleReport extends VerifyResult {
  /** The statement's subjects; for the 0.2.x layout, its `diffHashes` in that shape. */
  subjects: InTotoSubject[];
  /** Why `valid` is false, as a sentence. Absent when it is true. */
  reason?: string;
}

/**
 * The bytes a signature covers. Through JSON first, so a statement held in memory (`Date`s) and
 * the same statement read back from disk (ISO strings) sign alike; then RFC 8785, so key order
 * and whitespace are not content and a third party with any JCS library can reproduce the bytes.
 */
function signedBytes(statement: object): string {
  return jcs(JSON.parse(JSON.stringify(statement)));
}

function hmacHex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time, and exact: an uppercase, truncated or padded rendering of the digest is not it. */
function signatureMatches(secret: string, payload: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const expected = Buffer.from(hmacHex(secret, payload), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function runStatement(predicate: RunPredicate): InTotoStatement<RunPredicate> {
  // `?? {}`: a bundle read from disk is whatever the file says, and a malformed one must be
  // judged invalid, not crash the judge.
  return makeInTotoStatement(predicate.diffHashes ?? {}, MAF_RUN_PREDICATE_TYPE, predicate);
}

function isStatement<T extends object>(bundle: T): bundle is Extract<T, { _type: string }> {
  return '_type' in bundle;
}

/** The signature `finalize` would write for `unsigned` under `signing`, in either shape. */
export function signBundle(
  unsigned: Omit<AttestationBundle, 'signature'> | Omit<SignedRunStatement, 'signature'>,
  signing: SigningOptions,
): string {
  const statement = isStatement(unsigned) ? unsigned : runStatement(unsigned);
  return hmacHex(signingKey(signing).secret, signedBytes(statement));
}

/**
 * A bundle file's text, as either shape `verify` reads. Refuses, with a sentence, what is not
 * JSON, not an object, or carries no signature; everything else is the signature's to judge.
 */
export function parseBundle(text: string): AnyBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err: unknown) {
    throw new Error(`The bundle is not JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const found = Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value;
    throw new Error(`The file is not an attestation bundle: expected a JSON object, found ${found}.`);
  }
  const signature = (value as { signature?: unknown }).signature;
  if (typeof signature !== 'string') {
    const found = signature === undefined ? 'undefined' : JSON.stringify(signature);
    throw new Error(`The file is not an attestation bundle: expected a string "signature", found ${found}.`);
  }
  return value as AnyBundle;
}

const KEY_NAME: Record<KeySource, string> = {
  env: 'a key of your own (MAF_SIGNING_KEY)',
  dev: 'the public development key',
};
const keyName = (claim: unknown): string =>
  claim === 'env' || claim === 'dev' ? KEY_NAME[claim] : `an unknown key source ${JSON.stringify(claim)}`;

/**
 * Valid when the signature matched and the bundle's own `keySource` names the key that checked
 * it. A 0.2.0 bundle (`legacy`, no `keySource`) says nothing about its key, so it verifies on its
 * signature against whichever key the caller supplies, and the result says legacy so a reader
 * cannot mistake "verified with the dev key because that is what I tried" for "signed with mine".
 */
function judge(
  check: { keySource: KeySource; legacy: boolean; subjects: InTotoSubject[] },
  claimed: unknown,
  signatureOk: boolean,
): BundleReport {
  const claimOk = claimed === undefined ? check.legacy : claimed === check.keySource;
  if (signatureOk && claimOk) return { valid: true, ...check };
  let reason: string;
  if (signatureOk) {
    reason = claimed === undefined
      ? 'The bundle names no keySource; every bundle since 0.2.1 carries one inside its signed payload.'
      : `The signature matches ${keyName(check.keySource)}, but the bundle claims ${keyName(claimed)}: ` +
        'its claim about the key that signed it is false.';
  } else if (claimed !== undefined && claimed !== check.keySource) {
    reason = `The bundle says ${keyName(claimed)} signed it, and this check used ${keyName(check.keySource)}: ` +
      (claimed === 'dev' ? 'unset MAF_SIGNING_KEY to check it against the development key.'
                         : 'set MAF_SIGNING_KEY to the key that signed it.');
  } else {
    reason = `The signature does not match the bundle's content under ${keyName(check.keySource)}: ` +
      'the bundle was changed after it was signed, or a different key signed it.';
  }
  return { valid: false, ...check, reason };
}

/**
 * Why a statement's subjects are not exactly its predicate's `diffHashes`, or `undefined` when
 * they are. Only the key holder can sign such a statement, but a reader counting its subjects
 * should not have to trust that they are the diffs the run recorded.
 */
function subjectMismatch(subject: unknown, diffHashes: unknown): string | undefined {
  if (!Array.isArray(subject)) return `The statement's subject is ${JSON.stringify(subject)}, not a list.`;
  if (diffHashes === null || typeof diffHashes !== 'object' || Array.isArray(diffHashes)) {
    return `The predicate's diffHashes is ${JSON.stringify(diffHashes)}; expected an object of name to sha256.`;
  }
  const recorded = diffHashes as Record<string, unknown>;
  const seen = new Set<string>();
  for (const entry of subject as unknown[]) {
    const { name, digest } = (entry ?? {}) as { name?: unknown; digest?: { sha256?: unknown } | null };
    const sha256 = digest?.sha256;
    if (typeof name !== 'string' || typeof sha256 !== 'string') {
      return `The statement has a subject that is not {name, digest: {sha256}}: ${JSON.stringify(entry)}.`;
    }
    if (seen.has(name)) return `The statement names the subject ${JSON.stringify(name)} twice.`;
    seen.add(name);
    if (!Object.hasOwn(recorded, name)) {
      return `The statement's subject ${JSON.stringify(name)} is not in its predicate's diffHashes.`;
    }
    if (recorded[name] !== sha256) {
      return `The statement's subject ${JSON.stringify(name)} has sha256 ${sha256}, and its predicate's ` +
        `diffHashes records ${JSON.stringify(recorded[name])}.`;
    }
  }
  const unnamed = Object.keys(recorded).filter((name) => !seen.has(name));
  return unnamed.length === 0 ? undefined
    : `The predicate's diffHashes records ${unnamed.map((n) => JSON.stringify(n)).join(', ')}, which the ` +
      'statement does not name as a subject.';
}

function examine(bundle: AnyBundle, signing: SigningOptions): BundleReport {
  const { secret, keySource } = signingKey(signing);
  if (isStatement(bundle)) {
    const { signature, ...statement } = bundle;
    const predicate = statement.predicate as { keySource?: unknown; diffHashes?: unknown } | null | undefined;
    const claimed: unknown = predicate?.keySource;
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    const check = { keySource, legacy: false, subjects };
    // Signed bytes of another statement type would still match; MAF vouches only for its own.
    if (statement._type !== IN_TOTO_STATEMENT_TYPE || statement.predicateType !== MAF_RUN_PREDICATE_TYPE) {
      const [field, found, expected] = statement._type !== IN_TOTO_STATEMENT_TYPE
        ? ['_type', statement._type, IN_TOTO_STATEMENT_TYPE]
        : ['predicateType', statement.predicateType, MAF_RUN_PREDICATE_TYPE];
      const reason = `The statement's ${field} is ${JSON.stringify(found)}; MAF signs ${JSON.stringify(expected)}.`;
      return { valid: false, ...check, reason };
    }
    const report = judge(check, claimed, signatureMatches(secret, signedBytes(statement), signature));
    const mismatch = report.valid ? subjectMismatch(statement.subject, predicate?.diffHashes) : undefined;
    return mismatch === undefined ? report : { valid: false, ...check, reason: mismatch };
  }
  const { signature, ...predicate } = bundle;
  const claimed: unknown = (predicate as { keySource?: unknown }).keySource;
  const subjects = runStatement(predicate).subject;
  // `bundle()` hands its caller the predicate with the statement's signature: re-wrapped, it is
  // the statement that was signed.
  if (signatureMatches(secret, signedBytes(runStatement(predicate)), signature)) {
    return judge({ keySource, legacy: false, subjects }, claimed, true);
  }
  // The 0.2.x layout: the same fields, signed over `JSON.stringify` in insertion order. Legacy
  // only when that signature is the one that matched; a bundle matching neither is not known to
  // be a 0.2.x bundle.
  const legacy = signatureMatches(secret, JSON.stringify(predicate), signature);
  return judge({ keySource, legacy, subjects }, claimed, legacy);
}

export class Attestor implements AttestorHandle {
  private calls:     ToolCallRecord[] = [];
  private approvals: ReviewAttestation[] = [];
  private diffHashes: Record<string, string> = {};
  private securityFindings: SecurityFindingsRecord[] = [];
  private readonly signingSecret: string;
  private readonly keySource: KeySource;

  /**
   * `signing` is required so no call site gets the development key by leaving an argument out —
   * which is how both production call sites came to sign with it silently.
   */
  constructor(
    private readonly runId: RunId,
    private readonly graph: MemoryGraph,
    private readonly attestationsDir: string,
    signing: SigningOptions,
    private readonly harnessSha?: string,
  ) {
    const key = signingKey(signing);
    this.signingSecret = key.secret;
    this.keySource = key.keySource;
  }

  /**
   * Signing options for a production call site, from `MAF_SIGNING_KEY`. When that gives no usable
   * secret it writes one warning line to stderr: the bundle records `keySource: 'dev'`, but nobody
   * reads a bundle before trusting a run, so the run itself has to say it.
   */
  static resolveSigningSecret(env: NodeJS.ProcessEnv = process.env): SigningOptions {
    const secret = env[SIGNING_KEY_ENV];
    if (!secret || secret === DEV_SIGNING_KEY) {
      process.stderr.write(`${DEV_KEY_WARNING}\n`);
      return {};
    }
    return { secret };
  }

  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> {
    const record: ToolCallRecord = { id: crypto.randomUUID(), ...call };
    this.calls.push(record);

    await this.graph.addNode({
      kind:       'ToolInvocation',
      label:      `${call.toolId}@${call.runId}`,
      properties: {
        toolId:    call.toolId,
        input:     JSON.stringify(call.input),
        exitCode:  call.result.exitCode,
        durationMs: call.durationMs,
        policyVerdict: call.policyDecision.verdict,
        ...(this.harnessSha ? { harness_sha: this.harnessSha } : {}),
      },
      runId: call.runId,
    });
  }

  /**
   * Makes `name` a subject of the run's statement, with the sha256 of `diffContent`. A second
   * call for the same name replaces the first: a retried node's subject is the diff that stood.
   */
  recordDiffHash(name: string, diffContent: string): void {
    this.diffHashes[name] = crypto.createHash('sha256').update(diffContent).digest('hex');
  }

  addApproval(attestation: ReviewAttestation): void {
    this.approvals.push(attestation);
  }

  recordSecurityFindings(nodeId: string, result: SecurityReviewResult): void {
    this.securityFindings.push({ nodeId, result });
  }

  /**
   * Signs the run and writes it to `<attestationsDir>/<runId>.bundle.json`: an in-toto Statement
   * (subjects: the recorded diffs; predicate: the run) with its signature beside it.
   */
  async finalize(
    builder: SlsaBuilder,
    invocation: SlsaInvocation,
    materials: SlsaMaterial[],
    outcome: RunOutcome,
    goldens?: GoldensSection,
  ): Promise<SignedRunStatement> {
    const provenance: SlsaProvenance = {
      buildType:  'https://maf.dev/build/v1',
      builder,
      invocation,
      materials,
      runEnv: {
        platform:    process.platform,
        nodeVersion: process.version,
        timestamp:   new Date().toISOString(),
      },
    };

    const predicate: RunPredicate = {
      runId:            this.runId,
      keySource:        this.keySource,
      provenance,
      toolCalls:        this.calls,
      approvals:        this.approvals,
      diffHashes:       this.diffHashes,
      securityFindings: this.securityFindings,
      outcome,
      ...(goldens ? { goldens } : {}),
      bundledAt:        new Date(),
    };
    const statement = runStatement(predicate);
    const signature = hmacHex(this.signingSecret, signedBytes(statement));
    const signed: SignedRunStatement = { ...statement, signature };

    await mkdir(this.attestationsDir, { recursive: true });
    const filePath = path.join(this.attestationsDir, `${this.runId}.bundle.json`);
    await writeFile(filePath, JSON.stringify(signed, null, 2), 'utf8');
    return signed;
  }

  /**
   * `finalize`, returned in the 0.2.x layout its callers read fields from: the predicate, with
   * the statement's signature. `verify` accepts it (it re-wraps the predicate to check); the file
   * on disk is the statement.
   */
  async bundle(
    builder: SlsaBuilder,
    invocation: SlsaInvocation,
    materials: SlsaMaterial[],
    outcome: RunOutcome,
    goldens?: GoldensSection,
  ): Promise<AttestationBundle> {
    const { predicate, signature } = await this.finalize(builder, invocation, materials, outcome, goldens);
    return { ...predicate, signature };
  }

  /**
   * Whether `bundle` was signed with the key `signing` names (no secret: the development key),
   * and says so: a bundle that claims `keySource: "env"` must verify with the env key, one that
   * claims `"dev"` with the development key — so a bundle re-signed with the public key cannot
   * claim a real one. Either shape: the statement a run writes, or the layout `bundle()` returns
   * and 0.2.x wrote.
   *
   * A boolean, so `if (!Attestor.verify(…))` means what it says. `inspect` returns the detail.
   */
  static verify(bundle: AnyBundle, signing: SigningOptions): boolean {
    return examine(bundle, signing).valid;
  }

  /** `verify`, with the key source the check was made against and whether the bundle is legacy. */
  static inspect(bundle: AnyBundle, signing: SigningOptions): VerifyResult {
    const { valid, keySource, legacy } = examine(bundle, signing);
    return { valid, keySource, legacy };
  }

  /** `inspect`, with the bundle's subjects and, when it is invalid, why. */
  static report(bundle: AnyBundle, signing: SigningOptions): BundleReport {
    return examine(bundle, signing);
  }
}

export function buildInTotoStatement(
  subjectFiles: Record<string, string>,
  builder: SlsaBuilder,
  invocation: SlsaInvocation,
): string {
  return JSON.stringify({
    _type: 'https://in-toto.io/Statement/v0.1',
    subject: Object.entries(subjectFiles).map(([name, sha256]) => ({ name, digest: { sha256 } })),
    predicateType: 'https://slsa.dev/provenance/v0.2',
    predicate: { builder, buildType: 'https://maf.dev/build/v1', invocation },
  });
}
