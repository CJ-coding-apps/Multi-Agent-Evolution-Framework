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

/** The public development key. Anyone can sign with it, which is why a bundle says when it was used. */
export const DEV_SIGNING_KEY = 'dev-secret';

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

  recordDiffHash(filePath: string, diffContent: string): void {
    this.diffHashes[filePath] = crypto.createHash('sha256').update(diffContent).digest('hex');
  }

  addApproval(attestation: ReviewAttestation): void {
    this.approvals.push(attestation);
  }

  recordSecurityFindings(nodeId: string, result: SecurityReviewResult): void {
    this.securityFindings.push({ nodeId, result });
  }

  async bundle(
    builder: SlsaBuilder,
    invocation: SlsaInvocation,
    materials: SlsaMaterial[],
    outcome: RunOutcome,
    goldens?: GoldensSection,
  ): Promise<AttestationBundle> {
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

    const unsignedBundle = {
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
    const signature = crypto.createHmac('sha256', this.signingSecret)
      .update(JSON.stringify(unsignedBundle)).digest('hex');

    const bundle: AttestationBundle = { ...unsignedBundle, signature };

    await this.persist(bundle);
    return bundle;
  }

  private async persist(bundle: AttestationBundle): Promise<void> {
    await mkdir(this.attestationsDir, { recursive: true });
    const filePath = path.join(this.attestationsDir, `${bundle.runId}.bundle.json`);
    await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8');
  }

  /**
   * Checks `bundle` against the key `signing` names (no secret: the development key). The claim
   * has to agree as well as the signature: anyone holding the public development key can sign a
   * bundle that says `keySource: 'env'`, and that bundle must not pass as one.
   */
  static verify(bundle: AttestationBundle, signing: SigningOptions): VerifyResult {
    const { secret, keySource } = signingKey(signing);
    const { signature, ...rest } = bundle;
    const payload = JSON.stringify(rest);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    const given = Buffer.from(signature, 'hex');
    // timingSafeEqual throws on unequal lengths; a truncated signature is simply not this one.
    const signatureMatches = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    return { valid: signatureMatches && bundle.keySource === keySource, keySource };
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
