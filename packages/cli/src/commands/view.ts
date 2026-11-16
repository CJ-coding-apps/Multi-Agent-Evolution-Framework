import type { Command } from 'commander';
import { DEV_SIGNING_KEY } from '@maf/attestation';
import { viewRun, viewSession } from '@maf/viewer';

interface ViewOptions {
  dir: string;
  out?: string;
  session?: string;
}

/**
 * `maf view` — one file, written once, containing everything the record says.
 *
 * The command resolves the same signing key `maf attest verify` does, because a view rests on the
 * same claim: the banner is only worth the signature under it.
 */
export function registerViewCommand(program: Command): void {
  program
    .command('view')
    .description('Write one self-contained, network-free HTML view of a signed run record or an evolver session')
    .argument('[target]', 'a run id, or the path of a bundle file')
    .option('-o, --out <file.html>', 'write the view here (default: .maf/views/<id>.html)')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--session <id>', 'render .maf/evolve/<id>.json instead of a run')
    .action(async (target: string | undefined, options: ViewOptions) => {
      if (options.session !== undefined) {
        const result = await viewSession({
          target: options.session,
          dir: options.dir,
          ...(options.out !== undefined ? { out: options.out } : {}),
        });
        console.log(`[maf] view wrote ${result.outPath}`);
        return;
      }
      if (target === undefined) {
        throw new Error('maf view: name a run id or a bundle path, or pass --session <id>.');
      }
      // Not the run's warning, which is about signing: this command only checks.
      const secret = process.env['MAF_SIGNING_KEY'];
      if (!secret || secret === DEV_SIGNING_KEY) {
        process.stderr.write('[maf] viewing with the public development key; set MAF_SIGNING_KEY to check against yours\n');
      }
      const result = await viewRun({
        target,
        dir: options.dir,
        signing: { secret },
        ...(options.out !== undefined ? { out: options.out } : {}),
      });
      console.log(`[maf] view wrote ${result.outPath}`);
    });
}
