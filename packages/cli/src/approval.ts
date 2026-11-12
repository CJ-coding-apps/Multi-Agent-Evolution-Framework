/**
 * R2-M1: what `maf evolve approve` is allowed to apply.
 *
 * A needs-approval candidate is stored by the loop but never made CURRENT. To apply it the operator
 * names it, and the name has to mean one thing: a candidate id (`<base>-e<n>`) is unique within a
 * run but NOT across runs — two sessions evolving from the same base mint the same id — so the
 * record written at store time carries the session that minted it, and `approve` refuses an id that
 * more than one session claims. A record also carries the base the candidate was measured against;
 * if CURRENT has moved since, applying it would ship a harness whose improvement was measured
 * against a different harness, and the approval is refused.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refusePrototypeKey } from '@maf/types';

/** One stored candidate a human has not applied yet. */
export interface ApprovalRecord {
  /** The candidate's id, as the run minted it (`<base>-e<n>`). */
  id: string;
  /** The stored harness the approval would make CURRENT. */
  sha: string;
  /** The harness CURRENT named when the candidate was measured — its comparison base. */
  baseSha: string;
  /** The run that stored the candidate; `<session>/<id>` names it across sessions. */
  session: string;
}

const SUFFIX = '.needs-approval.json';
const SHA_RE = /^[0-9a-f]{64}$/;

export function approvalRecordPath(harnessesDir: string, sha: string): string {
  return path.join(harnessesDir, `${sha}${SUFFIX}`);
}

export async function writeApprovalRecord(dir: string, record: ApprovalRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(approvalRecordPath(dir, record.sha), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Every approval record in the store, in id order. A file that does not parse is an error, not a
 * skip: silently ignoring one could turn an ambiguous id into a "unique" one and apply a candidate
 * another session stored.
 */
export async function readApprovalRecords(dir: string): Promise<ApprovalRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records: ApprovalRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(SUFFIX)).sort()) {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'), refusePrototypeKey);
    } catch (err) {
      throw new Error(`approval record ${name} is not readable JSON (${err instanceof Error ? err.message : String(err)}); repair or remove it`);
    }
    const r = parsed as Partial<ApprovalRecord> | null;
    if (r === null || typeof r !== 'object'
      || typeof r.id !== 'string' || !SHA_RE.test(r.sha ?? '') || !SHA_RE.test(r.baseSha ?? '')
      || typeof r.session !== 'string')
      throw new Error(`approval record ${name} is not a valid record (id, sha, baseSha and session are required)`);
    records.push(r as ApprovalRecord);
  }
  return records.sort((a, b) => a.id.localeCompare(b.id) || a.session.localeCompare(b.session));
}
