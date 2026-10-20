import { test } from 'node:test';
import assert from 'node:assert/strict';
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
