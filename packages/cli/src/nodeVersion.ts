/**
 * The Node.js floor `maf` declares in its `engines` field.
 *
 * `engines` is a request, not a rule: npm installs the package anyway and prints a warning at most,
 * and `npm install -g` under a package manager that ignores the field says nothing at all. The code
 * that follows really does need this version, so the check is repeated here and the process stops
 * with one sentence rather than failing later inside a dependency with a stack trace (F3).
 */
export const MINIMUM_NODE_MAJOR = 22;

export interface NodeCheckIo {
  /** Where the refusal goes. */
  stderr: { write(text: string): unknown };
  /** Called with 1 when the running Node is too old; a test substitutes its own. */
  exit(code: number): unknown;
}

/**
 * Refuses to continue on a Node older than {@link MINIMUM_NODE_MAJOR}. Takes the version and the
 * exit so a test can drive it without a second Node process.
 */
export function requireSupportedNode(
  version: string = process.versions.node,
  io: NodeCheckIo = { stderr: process.stderr, exit: (code) => process.exit(code) },
): void {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) return;
  io.stderr.write(`maf requires Node ${MINIMUM_NODE_MAJOR} or newer (found v${version})\n`);
  io.exit(1);
}
