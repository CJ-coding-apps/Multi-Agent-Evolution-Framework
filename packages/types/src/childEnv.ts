/**
 * What maf's child processes may see of maf's own environment.
 *
 * Two policies, because the two kinds of child sit at different trust boundaries:
 *
 *  - **Backend CLIs** (`claude`, `codex`, `gemini`) are maf's own agent. They need the user's
 *    toolchain to work — `PATH`, `HOME`, the CLI's own login state — so subtracting everything
 *    would break them. What they must never receive is maf's own secrets, and maf's secrets are
 *    the ones it names: every `MAF_*` variable, `MAF_SIGNING_KEY` first among them.
 *
 *  - **Tools that run project code** (`test.run`, `grep`, `patch.apply`, `git.*`) run code the
 *    agent or the project wrote. They get an allowlist instead, because a deny rule has to name
 *    every secret and a list of names is always one release behind the next provider's token.
 *    The variables kept are the ones a command needs to find its toolchain and its home
 *    directory; nothing that authenticates maf, and nothing that names a maf run.
 *
 * Both are copies. A caller may add its own variables to the result without touching
 * `process.env`, and the child cannot mutate the parent's environment.
 */

// WP-3.9 — new file. `@maf/types` is additive only: nothing in it was renamed, narrowed or
// removed for this work; the package gained this module and a re-export in `index.ts`.

/**
 * The variables a tool-spawned child inherits. Deliberately small:
 *
 *  - the toolchain and the home directory (`PATH`, `HOME`, the Windows equivalents);
 *  - locale and time zone, so output and dates do not change with the parent's shell;
 *  - the temp directory, which runtimes and package managers need;
 *  - `NODE_EXTRA_CA_CERTS`, so a machine behind a corporate certificate still reaches registries.
 *
 * Not kept: anything `MAF_*` (notably `MAF_SIGNING_KEY`), provider API tokens (`OPENROUTER_*`,
 * `ANTHROPIC_*`, …), `NODE_OPTIONS` (a code-injection channel into every node child), git's own
 * environment (`GIT_DIR`, `GIT_*` — the git tools add what they need, confined), and
 * `SSH_AUTH_SOCK` (access to the user's agent is not something a project's test run needs in
 * order to report pass or fail).
 */
export const TOOL_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // POSIX
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'TZ',
  'TERM',
  'NODE_EXTRA_CA_CERTS',
  // Windows (process.env is case-insensitive there, so one spelling reaches the real value)
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'OS',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

/**
 * The environment for a child that runs project or model code: the allowlist, copied. `base`
 * exists for tests and for a caller that already has the environment it means to filter.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TOOL_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * True for the variables maf sets for itself, which a backend CLI has no reason to see.
 *
 * Case-insensitive on Windows, where the environment is case-insensitive: a `maf_signing_key`
 * set from a PowerShell prompt names the same variable the child reads as `MAF_SIGNING_KEY`, so a
 * case-sensitive match would hand it over. The platform is a parameter so the rule is testable on
 * every platform (WP-3.9 F15).
 */
export function isMafVariable(key: string, platform: NodeJS.Platform = process.platform): boolean {
  const name = platform === 'win32' ? key.toUpperCase() : key;
  return name.startsWith('MAF_');
}

/**
 * The environment for a backend CLI: everything the user has, except maf's own variables.
 * The CLI still needs `HOME` for its login and the user's `PATH` to find its runtime.
 */
export function backendEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isMafVariable(key) && value !== undefined) env[key] = value;
  }
  return env;
}
