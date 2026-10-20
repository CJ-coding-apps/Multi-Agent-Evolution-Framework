import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MINIMUM_NODE_MAJOR, requireSupportedNode } from '../nodeVersion.js';

// ORACLE (F3). `engines.node` is a request to npm, not an enforcement: npm prints a warning and
// installs anyway, and an older Node then fails somewhere inside maf with a message about the wrong
// thing. The first thing the CLI does is refuse, naming the version it needs and the one it found.

function probe(version: string): { stderr: string; exits: number[] } {
  let stderr = '';
  const exits: number[] = [];
  requireSupportedNode(version, {
    stderr: { write: (text: string) => { stderr += text; } },
    exit: (code: number) => { exits.push(code); },
  });
  return { stderr, exits };
}

test('a Node older than 22 is refused with one sentence naming both versions', () => {
  for (const version of ['18.19.0', '20.11.1', '21.7.3']) {
    const { stderr, exits } = probe(version);
    assert.deepEqual(exits, [1], `Node ${version} exits 1`);
    assert.equal(stderr, `maf requires Node ${MINIMUM_NODE_MAJOR} or newer (found v${version})\n`);
  }
});

test('Node 22 and newer pass without writing anything', () => {
  for (const version of ['22.0.0', '22.14.1', '24.3.0', '26.1.0']) {
    const { stderr, exits } = probe(version);
    assert.deepEqual(exits, [], `Node ${version} is accepted`);
    assert.equal(stderr, '');
  }
});

test('an unparseable version is refused rather than assumed new enough', () => {
  const { stderr, exits } = probe('unknown');
  assert.deepEqual(exits, [1]);
  assert.match(stderr, /^maf requires Node 22 or newer \(found vunknown\)\n$/);
});

// N2 (F3): the tests above drive the function; this drives the entry point. Only `main.ts` calling
// the guard *before* commander parses anything keeps every command out of reach on an old Node —
// remove the call and these unit tests still pass. `--version` is the probe because it is the first
// command a user runs: on Node 20 it must answer with the refusal, not a version.
test('the CLI runs the Node guard before any command (N2)', () => {
  const main = path.resolve(__dirname, '../main.js');
  // `process.versions.node` is not writable but is configurable, so the child can present as Node 20.
  const script = [
    "Object.defineProperty(process.versions, 'node', { value: '20.11.0', configurable: true, enumerable: true });",
    `process.argv = [process.execPath, ${JSON.stringify(main)}, '--version'];`,
    `require(${JSON.stringify(main)});`,
  ].join(' ');
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(
    run.status,
    1,
    `maf --version on Node 20 must exit 1 rather than run the command: ${run.stdout}${run.stderr}`,
  );
  assert.equal(run.stderr, `maf requires Node ${MINIMUM_NODE_MAJOR} or newer (found v20.11.0)\n`);
  assert.equal(run.stdout, '', 'commander never saw the argument');
});
