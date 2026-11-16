/**
 * The command's shell: read exactly the inputs the view is about, render, write one file.
 *
 * Every file effect goes through `ViewerIo`, so the acceptance test can prove — rather than
 * assume — that the viewer opens no file outside `.maf/` and the bundle it was given, and writes
 * exactly the file it names.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SigningOptions } from '@maf/attestation';
import { renderRunView, renderSessionView } from './render.js';

export interface ViewerIo {
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
}

/** The real effects. `writeFile` creates the output directory the command's path implies. */
export const defaultViewerIo: ViewerIo = {
  readFile: (file) => readFile(file, 'utf8'),
  async writeFile(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, 'utf8');
  },
};

export interface RunViewOptions {
  /** A run id, or the path of a bundle file. */
  target: string;
  /** The working directory whose `.maf/` holds the record (ignored for a path target). */
  dir: string;
  out?: string;
  signing?: SigningOptions;
}

export interface SessionViewOptions {
  target: string;
  dir: string;
  out?: string;
}

export interface ViewOutput {
  outPath: string;
  html: string;
}

const isPath = (target: string): boolean =>
  path.isAbsolute(target) || target.includes('/') || target.includes('\\') || target.endsWith('.json');

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** The run id the record names, or the caller's label when the record cannot be read. */
function runIdOf(bundleText: string, fallback: string): string {
  try {
    const parsed = JSON.parse(bundleText) as {
      runId?: unknown;
      predicate?: { runId?: unknown };
    };
    const id = parsed.runId ?? parsed.predicate?.runId;
    return typeof id === 'string' && id.length > 0 ? id : fallback;
  } catch {
    return fallback;
  }
}

function pathLabel(target: string): string {
  return path.basename(target).replace(/\.bundle\.json$/, '').replace(/\.json$/, '');
}

export async function viewRun(options: RunViewOptions, io: ViewerIo = defaultViewerIo): Promise<ViewOutput> {
  const dir = path.resolve(options.dir);
  const targetIsPath = isPath(options.target);
  const bundlePath = targetIsPath
    ? options.target
    : path.join(dir, '.maf', 'attestations', `${options.target}.bundle.json`);
  const bundleText = await io.readFile(bundlePath);
  // A run id also names its transcript; a bundle path is the only input. A missing transcript is
  // absent, not an error: the record itself does not require one.
  let transcriptText: string | undefined;
  if (!targetIsPath) {
    try {
      transcriptText = await io.readFile(path.join(dir, '.maf', 'transcripts', `${options.target}.jsonl`));
    } catch (err: unknown) {
      if (!isEnoent(err)) throw err;
    }
  }
  const label = targetIsPath ? pathLabel(options.target) : options.target;
  const html = renderRunView({
    bundleText,
    label,
    signing: options.signing ?? {},
    ...(transcriptText !== undefined ? { transcriptText } : {}),
  });
  const outPath = options.out ?? path.join(dir, '.maf', 'views', `${runIdOf(bundleText, label)}.html`);
  await io.writeFile(outPath, html);
  return { outPath, html };
}

export async function viewSession(options: SessionViewOptions, io: ViewerIo = defaultViewerIo): Promise<ViewOutput> {
  const dir = path.resolve(options.dir);
  const reportPath = isPath(options.target)
    ? options.target
    : path.join(dir, '.maf', 'evolve', `${options.target}.json`);
  const reportText = await io.readFile(reportPath);
  const label = isPath(options.target) ? pathLabel(options.target) : options.target;
  const html = renderSessionView({ reportText, label });
  const outPath = options.out ?? path.join(dir, '.maf', 'views', `${label}.html`);
  await io.writeFile(outPath, html);
  return { outPath, html };
}
