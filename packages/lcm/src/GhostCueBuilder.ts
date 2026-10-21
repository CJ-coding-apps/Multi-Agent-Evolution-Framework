import type { GhostCue, LcmSummaryId, LcmMessage } from '@maf/types';

export class GhostCueBuilder {
  build(messages: LcmMessage[], maxCues = 10): GhostCue[] {
    const summarized = messages.filter((m) => m.summaryId);
    const summaryIds = [...new Set(summarized.map((m) => m.summaryId!))];

    return summaryIds.slice(0, maxCues).map((summaryId: LcmSummaryId, i: number) => ({
      summaryId,
      cueText: `[Archived context segment ${i + 1} — call lcm_expand("${summaryId}") to recover full content]`,
      relevance: Math.max(0, 1 - i * 0.1),
    }));
  }

  /**
   * Build richer cues when summary content is available. The archive arrives oldest-first, and
   * the newest segments are the most relevant, so they are taken (and ranked) newest-first: the
   * version this replaces took the first ten in chronological order, which handed the model the
   * oldest context and dropped the newest whenever a session had more than ten summaries.
   */
  buildWithContent(
    summaries: Array<{ id: LcmSummaryId; content: string; level: number }>,
    maxCues = 10,
  ): GhostCue[] {
    return [...summaries].reverse().slice(0, maxCues).map((s, i) => ({
      summaryId: s.id,
      cueText: `[Level-${s.level} summary — ${s.content.slice(0, 120).replace(/\n/g, ' ')}… call lcm_expand("${s.id}") to expand]`,
      relevance: Math.max(0, 1 - i * 0.1),
    }));
  }
}
