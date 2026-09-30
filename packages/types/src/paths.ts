import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// PATH CONFINEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A path proven to lie inside a root, in both of the forms its two readers need.
 *
 * It exists because those two readers used to disagree about what a path was. `fs.write`
 * resolved `../.env` with `path.resolve` and wrote it, while the policy layer matched the raw
 * string `../.env` against the shipped "no `.env` file anywhere below the root" glob and did not
 * match — so the `protect-secrets` Deny rule permitted a write to a file outside the project.
 * Neither half was wrong on its own; the defect was that the checked value and the executed
 * value were two independently-derived strings.
 *
 * Producing both forms from one resolution is what makes them the same path. `relative` is what
 * a glob was written against and `absolute` is what a syscall takes, and they are two views of
 * one `realpath`, so a caller cannot reach one without having been checked as the other.
 */
export interface ConfinedPath {
  /** The root, with symlinks resolved — the origin `relative` is measured from. */
  readonly root: string;
  /** The path a syscall takes: absolute, symlink-resolved, inside `root`. */
  readonly absolute: string;
  /**
   * The path a glob matches: POSIX-separated, relative to `root`, with `./` and `..` already
   * collapsed, and `''` for the root itself.
   */
  readonly relative: string;
}

/**
 * A path that resolves outside its root, or that cannot be shown to be inside it.
 *
 * An error rather than a boolean, because the caller must not be free to carry on: the only safe
 * reading of "I could not show this is inside the root" is that it is not.
 */
export class PathEscapeError extends Error {
  constructor(
    readonly root: string,
    readonly requested: string,
    detail: string,
  ) {
    super(
      `Path ${JSON.stringify(requested)} is outside the project root ` +
      `${JSON.stringify(root)}: ${detail}`,
    );
    this.name = 'PathEscapeError';
  }
}

/** `lstat`/`readlink` hops before a chain of symbolic links is called a loop rather than a path. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves `p` against `root` and proves the result lies inside it.
 *
 * Three things `path.resolve(root, p)` followed by `startsWith(root)` does not do, each of which
 * was a way out of the root:
 *
 *  - **Symbolic links.** `root/link` pointing at `/etc` is lexically inside `root` and resolves
 *    outside it, so the check is made on `realpath` rather than on the string.
 *  - **A missing tail.** `realpath` refuses a path that does not exist, and that is every
 *    `fs.write` target, so the nearest existing ancestor is resolved and the missing part is
 *    appended. The case that defeats the simple form is a *dangling symlink*: its own name
 *    resolves to nothing yet opening it still lands wherever it points, so appending that name
 *    would prove a confinement the write does not honour. Each component is therefore
 *    `lstat`-ed, and one that is a link is followed by hand instead of appended.
 *  - **Separators.** `startsWith(root)` calls `/srv/root-evil` inside `/srv/root`.
 *    `path.relative` plus an explicit `..`/absolute test is separator-aware, and it answers
 *    correctly on Windows for a path on another drive.
 *
 * Relative paths are resolved against `root`, not against the caller's working directory. At
 * every call site in maf those are the same directory (`RoleDispatcher` passes `workingDir:
 * this.config.cwd` and `projectRoot: this.config.cwd`; the CLI builds it with one `workDir`), so
 * a relative path means what it always meant; the difference would only appear for a caller that
 * put its working directory somewhere other than the boundary it wants enforced.
 */
export async function resolveInside(root: string, p: string): Promise<ConfinedPath> {
  const realRoot = await realpath(path.resolve(root));
  const target = path.isAbsolute(p) ? path.normalize(p) : path.resolve(realRoot, p);
  const absolute = await realpathThrough(target);
  const relative = path.relative(realRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathEscapeError(realRoot, p, `it resolves to ${JSON.stringify(absolute)}`);
  }
  return { root: realRoot, absolute, relative: relative.split(path.sep).join('/') };
}

/**
 * `realpath` for a path whose tail may not exist yet, following symbolic links at every level.
 *
 * The recursion is on the parent, so the part that does not exist is always appended to
 * something that does — and a component that is a link is followed by hand, because `lstat`
 * sees it whether or not its target exists.
 */
async function realpathThrough(target: string, hops = 0): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new Error(`Too many symbolic links resolving ${JSON.stringify(target)}`);
  }
  let info;
  try {
    info = await lstat(target);
  } catch {
    const parent = path.dirname(target);
    // Walking up always reaches the filesystem root, whose `lstat` succeeds; this is the
    // termination proof for that walk, not a case a caller can reach.
    if (parent === target) throw new Error(`Cannot resolve ${JSON.stringify(target)}: no existing ancestor`);
    return path.join(await realpathThrough(parent, hops), path.basename(target));
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(target);
    return realpathThrough(path.resolve(path.dirname(target), link), hops + 1);
  }
  return realpath(target);
}
