import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { TOOL_ENV_ALLOWLIST, toolEnv, backendEnv, isMafVariable } from '../childEnv.js';

// ORACLE (WP-3.9: "tools spawn with the allowlisted env and a test proves MAF_SIGNING_KEY is
// absent in a child; backend CLIs receive the env minus MAF_*").
//
// The policy is one function; its wire into each spawner is asserted where that spawner lives
// (`packages/tools/src/__tests__/test-runner.test.ts`, and the adapters' tests). This file
// asserts the policy itself, including that it survives a real child process.

const SECRET = 'signing-secret-that-must-not-leak';

test('a tool child gets the allowlist, not the parent environment', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
    LANG: 'en_US.UTF-8',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    MAF_SIGNING_KEY: SECRET,
    MAF_HEADLESS: '1',
    OPENROUTER_API_KEY: 'sk-or-v1-nope',
    ANTHROPIC_API_KEY: 'sk-ant-nope',
    NODE_OPTIONS: '--require ./inject.js',
    GIT_DIR: '/somewhere/.git',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  };

  const env = toolEnv(base);

  assert.equal(env['PATH'], '/usr/bin:/bin');
  assert.equal(env['HOME'], '/home/tester');
  assert.equal(env['LANG'], 'en_US.UTF-8');
  assert.equal(env['NODE_EXTRA_CA_CERTS'], '/etc/ca.pem');
  for (const key of [
    'MAF_SIGNING_KEY', 'MAF_HEADLESS', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
    'NODE_OPTIONS', 'GIT_DIR', 'SSH_AUTH_SOCK',
  ]) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach a tool child`);
  }
});

test('an undefined value in the parent is not invented', () => {
  const env = toolEnv({ PATH: undefined, HOME: '/home/tester' });
  assert.equal(Object.hasOwn(env, 'PATH'), false);
  assert.equal(env['HOME'], '/home/tester');
});

test('backend CLIs get the user environment minus MAF_* only', () => {
  const env = backendEnv({
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
    MAF_SIGNING_KEY: SECRET,
    MAF_HEADLESS: '1',
    MAF_ANY_FUTURE_VARIABLE: 'x',
    OPENROUTER_API_KEY: 'sk-or-v1-model-provider',
  });

  assert.equal(env['PATH'], '/usr/bin:/bin');
  assert.equal(env['HOME'], '/home/tester');
  // A provider key is the CLI's own business: the backend may need it to call the model.
  assert.equal(env['OPENROUTER_API_KEY'], 'sk-or-v1-model-provider');
  assert.equal(env['MAF_SIGNING_KEY'], undefined);
  assert.equal(env['MAF_HEADLESS'], undefined);
  assert.equal(env['MAF_ANY_FUTURE_VARIABLE'], undefined);
});

test('the result is a copy: writing to it does not change the parent environment', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', MAF_SIGNING_KEY: SECRET };
  const env = toolEnv(base);
  env['PATH'] = '/tampered';
  assert.equal(base['PATH'], '/usr/bin');

  const backend = backendEnv(base);
  backend['MAF_SIGNING_KEY'] = 'readded';
  assert.equal(base['MAF_SIGNING_KEY'], SECRET);
});

test('isMafVariable names the family and nothing else', () => {
  assert.equal(isMafVariable('MAF_SIGNING_KEY'), true);
  assert.equal(isMafVariable('MAF_RUN_ID'), true);
  assert.equal(isMafVariable('maf_signing_key'), false);
  assert.equal(isMafVariable('PATH'), false);
});

test('on Windows the match is case-insensitive, because the environment is (WP-3.9 F15)', () => {
  // `process.env` on Windows folds case, so `maf_signing_key` in a PowerShell prompt IS the key
  // the child reads as `MAF_SIGNING_KEY`; a case-sensitive match would pass it to a backend CLI.
  assert.equal(isMafVariable('maf_signing_key', 'win32'), true);
  assert.equal(isMafVariable('Maf_Headless', 'win32'), true);
  assert.equal(isMafVariable('PATH', 'win32'), false);
  // POSIX keeps the exact spelling: `maf_signing_key` there is a different variable, and maf sets
  // none of them, so it is the user's and stays.
  assert.equal(isMafVariable('maf_signing_key', 'linux'), false);
});

test('a real child started with toolEnv cannot read MAF_SIGNING_KEY', () => {
  const out = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.env["MAF_SIGNING_KEY"] ?? "ABSENT"))'],
    {
      encoding: 'utf8',
      env: toolEnv({ PATH: process.env['PATH'], MAF_SIGNING_KEY: SECRET }),
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'ABSENT');
});

test('the allowlist is small and never carries a maf or provider variable', () => {
  for (const key of TOOL_ENV_ALLOWLIST) {
    assert.equal(isMafVariable(key), false, `${key} is a maf variable`);
    assert.equal(/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|OLLAMA)_/.test(key), false, `${key} is a provider key`);
  }
});
