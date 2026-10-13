import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mafVersion } from '@maf/attestation';

// ORACLE: D-13 / WP-2.8 F2 — `maf --version` printed a literal ('0.2.1') that no release bump
// touched; it is the version the packages ship as, the same one every component id carries.

test('maf --version prints the version the packages ship as', () => {
  const main = path.join(__dirname, '..', 'main.js');
  const result = spawnSync(process.execPath, [main, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const cliPkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(result.stdout.trim(), mafVersion());
  assert.equal(mafVersion(), cliPkg.version, 'every @maf package is released under one version');
});
