/**
 * What a maf child process may see of maf's own environment.
 *
 * The children this covers are the ones that run *project* code rather than being maf's own
 * agent. In 0.5.1 that is one tool: `patch.apply` spawns `git apply` on a diff an agent wrote.
 * Such a child gets an allowlist rather than the parent's environment, because a deny rule has to
 * name every secret and a list of names is always one release behind the next provider's token.
 *
 * The variables kept are the ones a command needs to find its toolchain, its home directory and
 * its temporary directory; nothing that authenticates maf, nothing that names a maf run, and
 * nothing of git's own — `patch.apply` sets `GIT_DIR`, `GIT_WORK_TREE` and the config switches it
 * needs itself, so a `GIT_*` inherited from the host could only fight them (HS1/HP3).
 */

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
 * environment (`GIT_DIR`, `GIT_*`), and `SSH_AUTH_SOCK` (access to the user's agent is not
 * something a project's test run needs in order to report pass or fail).
 *
 * Not exported: the list is an implementation detail of `toolEnv`, and a caller that edited it
 * would silently change every child. A caller that needs to add a variable adds it to the copy
 * `toolEnv` returns.
 */
const TOOL_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
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
 *
 * It is a copy. A caller may add its own variables to the result without touching `process.env`,
 * and the child cannot mutate the parent's environment.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TOOL_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
