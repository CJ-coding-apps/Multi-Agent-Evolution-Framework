import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Everything a run needs that is not code: the shipped policy and role set, their prompts, the
 * default config, and the golden corpus. They sit beside the compiled `dist/` (`dist/` → `assets/`)
 * rather than under the user's `.maf/`, so an installed `maf` works in a repository it has never
 * seen, and `maf init` writes the same bytes it runs from.
 *
 * The resolver is anchored to the module's own directory, never to `process.cwd()`: a run's working
 * directory is the user's repository, and the package must not read a file of the same name there.
 * `__dirname` rather than `import.meta.url` because this package compiles to CommonJS.
 */
export function assetsRoot(): string {
  return path.resolve(__dirname, '..', 'assets');
}

/** The golden corpus embedded in the package (`assets/goldens`). */
export function goldensAssetRoot(): string {
  return path.join(assetsRoot(), 'goldens');
}

/** The text of one embedded file, refused if `relative` does not stay under `assets/`. */
export async function readAsset(relative: string): Promise<string> {
  return readFile(assetPath(relative), 'utf8');
}

/** The absolute path of one embedded file, refused if `relative` does not stay under `assets/`. */
export function assetPath(relative: string): string {
  const root = assetsRoot();
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`asset ${JSON.stringify(relative)} resolves to ${resolved}, outside ${root}`);
  }
  return resolved;
}
