import type { LcmMessageId, RunId } from '@maf/types';
import type { LcmStore } from './LcmStore.js';

export class SessionMerger {
  constructor(private readonly store: LcmStore) {}

  /**
   * Union-merge: copy all messages from source runs into `targetRunId`, re-tagging session and
   * run id.
   *
   * WP-3.2 F3: the copy is re-linked to the summaries that covered the originals. The version this
   * replaces copied each message's `summaryId` onto the new row but never linked the summary to the
   * new message ids, so the target session could not see the archive its own messages pointed at:
   * a merged run lost every summary and re-summarized text it already had. The summary rows
   * themselves are shared rather than duplicated — ids are global — and each is linked to both the
   * source messages and their copies, so `lcm.expand` works from either session.
   */
  async mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<void> {
    for (const sourceRunId of sourceRunIds) {
      const messages = this.store.getMessagesBySession(sourceRunId);
      if (messages.length === 0) continue;

      // The summaries that cover this source session, read before the copy, and the mapping from
      // each source message to the copy that will carry it.
      const summaries = this.store.getSummariesForSession(sourceRunId);
      const copies = new Map<LcmMessageId, LcmMessageId>();

      for (const message of messages) {
        const copyId = this.store.insertMessage({
          sessionId: targetRunId,
          runId:     targetRunId,
          role:      message.role,
          content:   message.content,
          tokens:    message.tokens,
          ...(message.parentId  ? { parentId:  message.parentId  } : {}),
          ...(message.summaryId ? { summaryId: message.summaryId } : {}),
        });
        copies.set(message.id, copyId);
      }

      for (const summary of summaries) {
        const copied = summary.messageIds
          .map((id) => copies.get(id))
          .filter((id): id is LcmMessageId => id !== undefined);
        if (copied.length > 0) this.store.linkSummaryMessages(summary.id, copied);
      }
    }
  }
}
