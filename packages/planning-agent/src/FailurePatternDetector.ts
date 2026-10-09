import type { GraphQueryRunner } from '@maf/types';
import { recallFailures } from '@maf/memory-graph';
import type { RecalledFailure } from '@maf/memory-graph';

export interface FailurePattern {
  taskLabel:    string;
  filePaths:    string[];
  failureType:  string;
  occurrences:  number;
  lastSeen:     string;
}

export class FailurePatternDetector {
  constructor(private readonly graph: GraphQueryRunner) {}

  // Find tasks that caused failures on files overlapping with the given paths
  async detectForPaths(filePaths: string[]): Promise<FailurePattern[]> {
    const patterns: FailurePattern[] = [];

    for (const filePath of filePaths) {
      const failures = await recallFailures(this.graph, { path: filePath, limit: 10 });
      patterns.push(...failures.map((f) => toPattern(f, [filePath])));
    }

    return dedup(patterns);
  }

  // Detect failure patterns from similar task descriptions — the planner's own recall query.
  async detectForTitle(title: string): Promise<FailurePattern[]> {
    const failures = await recallFailures(this.graph, { title, limit: 10 });
    return failures.map((f) => toPattern(f, []));
  }

  formatAsContext(patterns: FailurePattern[]): string {
    if (patterns.length === 0) return '';
    const items = patterns.map(
      (p) => `- Task "${p.taskLabel}" → ${p.failureType}${p.filePaths.length > 0 ? ` (on ${p.filePaths[0]})` : ''}`
    ).join('\n');
    return `<past-failures>\nThese similar tasks failed previously — avoid repeating these patterns:\n${items}\n</past-failures>`;
  }
}

function toPattern(f: RecalledFailure, filePaths: string[]): FailurePattern {
  return { taskLabel: f.task, filePaths, failureType: f.reason, occurrences: 1, lastSeen: f.recordedAt };
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
