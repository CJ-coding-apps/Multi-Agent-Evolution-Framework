import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { Attestor, parseBundle } from '@maf/attestation';
import type { AnyBundle, SigningOptions } from '@maf/attestation';

export interface AttestVerifyOutcome {
  /** One fact per line: `valid`, `keySource`, `subjects`, and `legacy` when it is. */
  lines:    string[];
  /** Why the bundle did not verify, as a sentence. Absent when it did. */
  failure?: string;
}

const KEY_NOTE = {
  env: 'checked against MAF_SIGNING_KEY',
  dev: 'checked against the public development key: a valid signature here is evidence of nothing',
} as const;

/** `maf attest verify`, minus the process: what it prints, and the failure it exits 1 with. */
export async function attestVerify(file: string, signing: SigningOptions): Promise<AttestVerifyOutcome> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { lines: [], failure: `Cannot read the bundle at ${file}: ${message}.` };
  }
  let bundle: AnyBundle;
  try {
    bundle = parseBundle(text);
  } catch (err: unknown) {
    return { lines: [], failure: `${err instanceof Error ? err.message : String(err)} (${file})` };
  }
  const report = Attestor.report(bundle, signing);
  const lines = [
    `valid: ${report.valid}`,
    `keySource: ${report.keySource} (${KEY_NOTE[report.keySource]})`,
    `subjects: ${report.subjects.length}`,
    ...(report.legacy ? ['legacy: true (a 0.2.x bundle: custom JSON, not an in-toto Statement)'] : []),
  ];
  return report.valid ? { lines } : { lines, failure: report.reason ?? 'The bundle did not verify.' };
}

export function registerAttestCommand(program: Command): void {
  const cmd = program
    .command('attest')
    .description('Check run attestation bundles');

  cmd
    .command('verify <bundle>')
    .description('Verify a bundle against MAF_SIGNING_KEY (the public development key when it is unset)')
    .action(async (bundlePath: string) => {
      // The same resolution `run` signs with, so an unset key warns here exactly as it does there.
      const outcome = await attestVerify(path.resolve(bundlePath), Attestor.resolveSigningSecret(process.env));
      for (const line of outcome.lines) console.log(line);
      if (outcome.failure !== undefined) throw new Error(outcome.failure);
    });
}
