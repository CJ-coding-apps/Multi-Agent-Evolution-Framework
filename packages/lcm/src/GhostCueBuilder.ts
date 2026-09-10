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

  // Build richer cues when summary content is available
  buildWithContent(
    summaries: Array<{ id: LcmSummaryId; content: string; level: number }>,
    maxCues = 10,
  ): GhostCue[] {
    return summaries.slice(0, maxCues).map((s, i) => ({
      summaryId: s.id,
      cueText: `[Level-${s.level} summary — ${s.content.slice(0, 120).replace(/\n/g, ' ')}… call lcm_expand("${s.id}") to expand]`,
      relevance: Math.max(0, 1 - i * 0.1),
    }));
  }
}
