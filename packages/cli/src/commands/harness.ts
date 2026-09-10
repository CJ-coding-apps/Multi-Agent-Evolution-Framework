import path from 'node:path';
import type { Command } from 'commander';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';

function printConfig(cfg: HarnessConfig, currentSha?: string): void {
  const mark = cfg.sha === currentSha ? ' (CURRENT)' : '';
  const bundles = cfg.processorBundles.length
    ? cfg.processorBundles.map((p) => p.name).join(', ')
    : '(none — CLI-era behavior)';
  console.log(`  ${cfg.id.padEnd(20)} ${shortSha(cfg.sha)}${mark}`);
  console.log(`    roles:      ${cfg.roleSet.roles.map((r) => r.role).join(', ')} (default: ${cfg.roleSet.defaultRole})`);
  console.log(`    processors: ${bundles}`);
  if (cfg.plannerRecall) console.log(`    recall:     failures≤${cfg.plannerRecall.pastFailuresLimit ?? '—'} lcmTokens≤${cfg.plannerRecall.lcmGrepBudgetTokens ?? '—'}`);
}

export function registerHarnessCommand(program: Command): void {
  const cmd = program
    .command('harness')
    .description('Manage content-addressed harness configurations');

  cmd
    .command('list')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('List stored harness configurations')
    .action(async (opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const all = await store.list();
      if (all.length === 0) {
        console.log('[maf] no harnesses — run once to mint legacy-default, or use maf harness import');
        return;
      }
      const current = await store.current();
      console.log(`[maf] ${all.length} harness(es) in ${store.dir}:`);
      for (const cfg of all) printConfig(cfg, current?.sha);
    });

  cmd
    .command('show <ref>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Show a harness by id, sha, or "current"')
    .action(async (ref: string, opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const cfg = await store.load(ref);
      console.log(JSON.stringify(cfg, null, 2));
    });

  cmd
    .command('set-current <ref>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Point CURRENT at a stored harness')
    .action(async (ref: string, opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const cfg = await store.load(ref);
      await store.setCurrent(cfg.sha);
      console.log(`[maf] CURRENT → ${cfg.id} (${shortSha(cfg.sha)})`);
    });
}
