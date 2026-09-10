import crypto from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  AttestorHandle, ToolCallRecord, AttestationBundle, SlsaProvenance,
  SlsaBuilder, SlsaInvocation, SlsaMaterial, ReviewAttestation,
  RunId, PolicyDecision, SecurityReviewResult, SecurityFindingsRecord, GoldensSection,
} from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';

export class Attestor implements AttestorHandle {
  private calls:     ToolCallRecord[] = [];
  private approvals: ReviewAttestation[] = [];
  private diffHashes: Record<string, string> = {};
  private securityFindings: SecurityFindingsRecord[] = [];

  constructor(
    private readonly runId: RunId,
    private readonly graph: MemoryGraph,
    private readonly attestationsDir: string,
    private readonly signingSecret: string = process.env['MAF_SIGNING_KEY'] ?? 'dev-secret',
    private readonly harnessSha?: string,
  ) {}

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
      provenance,
      toolCalls:        this.calls,
      approvals:        this.approvals,
      diffHashes:       this.diffHashes,
      securityFindings: this.securityFindings,
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

  static verify(bundle: AttestationBundle, signingSecret: string): boolean {
    const { signature, ...rest } = bundle;
    const payload = JSON.stringify(rest);
    const expected = crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
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
