import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mafVersion } from '@maf/attestation';

// ORACLE: the published entry point is a shebang script, so it must run when the OS — not a caller
// who typed `node <file>` — reads its first line. `version.test.ts` spawns `node main.js`, which
// never touches the shebang, so it cannot see this. The interpreter line is
// `#!/usr/bin/env -S node --max-old-space-size=8192`: without `-S`, a kernel that hands the whole
// rest of the line to `env` as ONE argument (Linux) makes `env` look for a program named
// "node --max-old-space-size=8192" and fail; macOS splits that argument and hides the bug, which
// is why this only has teeth on the Linux CI runner.

const execFileAsync = promisify(execFile);

test('the built bin runs when executed directly, through its shebang', async () => {
  const main = path.join(__dirname, '..', 'main.js');
  chmodSync(main, 0o755); // tsc writes 0644; the kernel needs the exec bit before it reads the shebang
  const { stdout } = await execFileAsync(main, ['--version'], { encoding: 'utf8' }).catch(
    (e: { code?: number; signal?: string; stdout?: string; stderr?: string }) => assert.fail(
      `executing ${main} directly failed (${e.signal ?? `exit ${String(e.code)}`}): ${e.stdout ?? ''}${e.stderr ?? ''}`,
    ),
  );
  assert.equal(stdout.trim(), mafVersion());
});
