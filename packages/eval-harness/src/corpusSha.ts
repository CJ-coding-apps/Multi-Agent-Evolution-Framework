import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@maf/harness-config';
import type { GoldenTask } from './GoldenTask.js';

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** Every regular file under `dir`, as corpus-relative posix paths. */
async function listFiles(corpusRoot: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(corpusRoot, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(corpusRoot, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The corpus sha (D-14): sha256 over the canonical JSON of the tasks together with the content
 * of every file they read — each fixture tree and rubric. Editing a fixture's test.js changes
 * it as surely as editing corpus.json, so two results with equal shas were measured against the
 * same yardstick. Files beside the corpus that no task reads (a baseline, a script) are not in it.
 */
export async function computeCorpusSha(corpusRoot: string, corpus: readonly GoldenTask[]): Promise<string> {
  const paths = new Set<string>();
  for (const task of corpus) {
    for (const f of await listFiles(corpusRoot, path.posix.normalize(task.repoFixture))) paths.add(f);
    for (const v of task.verifiers) if (v.kind === 'llm-judge') paths.add(path.posix.normalize(v.rubricFile));
  }
  const files: Array<[string, string]> = [];
  for (const rel of [...paths].sort()) files.push([rel, sha256(await readFile(path.join(corpusRoot, rel)))]);
  return sha256(canonicalJson({ tasks: corpus, files }));
}
