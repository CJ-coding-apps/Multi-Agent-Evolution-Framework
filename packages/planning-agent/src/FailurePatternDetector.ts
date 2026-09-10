import type { RunId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';

export interface FailurePattern {
  taskLabel:    string;
  filePaths:    string[];
  failureType:  string;
  occurrences:  number;
  lastSeen:     string;
}

export class FailurePatternDetector {
  constructor(private readonly graph: MemoryGraph) {}

  // Find tasks that caused failures on files overlapping with the given paths
  async detectForPaths(filePaths: string[]): Promise<FailurePattern[]> {
    const patterns: FailurePattern[] = [];

    for (const filePath of filePaths) {
      const rows = await this.graph.query(
        `MATCH (t:MemoryNode {kind: 'Task'})-[:CAUSED_FAILURE]->(f:MemoryNode {kind: 'Failure'})
         MATCH (t)-[:MODIFIED]->(file:MemoryNode {kind: 'File', label: $path})
         RETURN t.label AS task, f.properties AS failure, file.label AS file, t.created_at AS ts LIMIT 10`,
        { path: filePath },
      ) as Array<{ task: string; failure: string; file: string; ts: string }>;

      for (const r of rows) {
        const props = tryParse(r.failure);
        patterns.push({
          taskLabel:   r.task,
          filePaths:   [r.file],
          failureType: String(props['type'] ?? 'unknown'),
          occurrences: 1,
          lastSeen:    r.ts,
        });
      }
    }

    return dedup(patterns);
  }

  // Detect failure patterns from similar task descriptions
  async detectForTitle(title: string): Promise<FailurePattern[]> {
    const keywords = title.split(/\s+/).slice(0, 3).join(' ');
    const rows = await this.graph.query(
      `MATCH (t:MemoryNode {kind: 'Task'})-[:CAUSED_FAILURE]->(f:MemoryNode {kind: 'Failure'})
       WHERE t.label CONTAINS $kw
       RETURN t.label AS task, f.properties AS failure, t.created_at AS ts LIMIT 10`,
      { kw: keywords },
    ) as Array<{ task: string; failure: string; ts: string }>;

    return rows.map((r) => {
      const props = tryParse(r.failure);
      return {
        taskLabel:   r.task,
        filePaths:   [],
        failureType: String(props['type'] ?? 'unknown'),
        occurrences: 1,
        lastSeen:    r.ts,
      };
    });
  }

  formatAsContext(patterns: FailurePattern[]): string {
    if (patterns.length === 0) return '';
    const items = patterns.map(
      (p) => `- Task "${p.taskLabel}" → ${p.failureType}${p.filePaths.length > 0 ? ` (on ${p.filePaths[0]})` : ''}`
    ).join('\n');
    return `<past-failures>\nThese similar tasks failed previously — avoid repeating these patterns:\n${items}\n</past-failures>`;
  }
}

function tryParse(s: unknown): Record<string, unknown> {
  if (typeof s === 'object' && s !== null) return s as Record<string, unknown>;
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
}

function dedup(patterns: FailurePattern[]): FailurePattern[] {
  const seen = new Map<string, FailurePattern>();
  for (const p of patterns) {
    const key = `${p.taskLabel}:${p.failureType}`;
    const existing = seen.get(key);
    if (existing) {
      existing.occurrences++;
      existing.filePaths = [...new Set([...existing.filePaths, ...p.filePaths])];
    } else {
      seen.set(key, { ...p });
    }
  }
  return [...seen.values()];
}
