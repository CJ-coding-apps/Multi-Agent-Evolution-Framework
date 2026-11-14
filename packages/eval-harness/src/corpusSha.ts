import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@maf/harness-config';
import type { GoldenTask } from './GoldenTask.js';
import { loadHiddenStore, readHiddenFile } from './hiddenStore.js';

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
 * of every file they read — each fixture tree and rubric — and every hidden check, decoded from
 * the hidden store (R6-H1). Editing a fixture's test.js or a hidden check changes it as surely as
 * editing corpus.json, so two results with equal shas were measured against the same yardstick.
 * Files beside the corpus that no task reads (a baseline, a script) are not in it; neither is a
 * stored reference solution, which exists only to prove the task solvable offline and is never
 * copied into a run.
 */
export async function computeCorpusSha(
  corpusRoot: string, corpus: readonly GoldenTask[], opts: { hiddenStore?: string } = {},
): Promise<string> {
  const paths = new Set<string>();
  const readByARun = (f: string): boolean => {
    const segments = f.split('/');
    return !segments.includes('.reference') && !segments.includes('.checks');
  };
  for (const task of corpus) {
    for (const f of await listFiles(corpusRoot, path.posix.normalize(task.repoFixture))) {
      if (readByARun(f)) paths.add(f);
    }
    for (const v of task.verifiers) if (v.kind === 'llm-judge') paths.add(path.posix.normalize(v.rubricFile));
  }
  const files: Array<[string, string]> = [];
  for (const rel of [...paths].sort()) files.push([rel, sha256(await readFile(path.join(corpusRoot, rel)))]);
  // R6-H1: hidden checks are stored encoded, so their content is hashed from the decoded bytes.
  // The key carries the task id and the fixture-relative path, so a check moved between tasks is a
  // different check even when its text is identical.
  const store = await loadHiddenStore(corpusRoot, opts.hiddenStore);
  for (const task of [...corpus].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const rel of [...(task.hiddenChecks ?? [])].sort())
      files.push([`${task.id}/${rel}`, sha256(readHiddenFile(store, 'checks', task.id, rel))]);
  }
  return sha256(canonicalJson({ tasks: corpus, files }));
}
