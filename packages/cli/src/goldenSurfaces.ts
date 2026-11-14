import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttestorHandle, TaskId } from '@maf/types';
import type { GoldenTask, RecordedSurface } from '@maf/eval-harness';

/** Files above this are not where a canary lives, and reading one would cost more than it finds. */
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/**
 * R6-H1: what a golden run recorded about one task, as text the hidden-store scan can read: every
 * attested tool call (the input the agent wrote — where a `test.run` script lives — and the
 * stdout/stderr it produced), and the run's transcript. The runner adds the final answer and the
 * worktree it leaves; these two it cannot see.
 *
 * `transcriptPath` is `<mafDir>/transcripts/<runId>.jsonl`, one file per run. Scanning the whole
 * run rather than only this task's turns is deliberate: a canary anywhere in the record means the
 * run is compromised, and a scan that tried to split the file by task could miss a turn.
 */
export function recordedSurfacesFrom(
  attestor: AttestorHandle, transcriptPath: string,
): (task: GoldenTask) => Promise<readonly RecordedSurface[]> {
  return async (task) => {
    const surfaces: RecordedSurface[] = [];
    for (const call of attestor.toolCallsForTask?.(task.id as TaskId) ?? []) {
      const tool = String(call.toolId);
      surfaces.push({ label: `tool ${tool} input`, text: JSON.stringify(call.input) });
      surfaces.push({ label: `tool ${tool} stdout`, text: call.result.stdout });
      surfaces.push({ label: `tool ${tool} stderr`, text: call.result.stderr });
      surfaces.push({ label: `tool ${tool} metadata`, text: JSON.stringify(call.result.metadata) });
    }
    let transcript: string;
    try {
      transcript = await readFile(transcriptPath, 'utf8');
    } catch (err) {
      // No transcript means no tool loop reached a model, which is not a failure to scan: the
      // attested calls above are the whole record. Any other error is a scan that did not happen.
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      return surfaces;
    }
    if (Buffer.byteLength(transcript) <= MAX_SCANNED_BYTES)
      surfaces.push({ label: `the transcript ${path.basename(transcriptPath)}`, text: transcript });
    return surfaces;
  };
}
