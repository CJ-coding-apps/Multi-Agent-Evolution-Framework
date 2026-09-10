import type { RunId } from '@maf/types';
import type { LcmStore } from './LcmStore.js';

export class SessionMerger {
  constructor(private readonly store: LcmStore) {}

  // Union-merge: copy all messages from source runs into targetRunId, re-tagging session/runId.
  // Summaries are not re-linked because their messageId references remain valid after copy.
  async mergeRuns(sourceRunIds: RunId[], targetRunId: RunId): Promise<void> {
    for (const sourceRunId of sourceRunIds) {
      const messages = this.store.getMessagesBySession(sourceRunId);
      for (const msg of messages) {
        this.store.insertMessage({
          sessionId: targetRunId,
          runId:     targetRunId,
          role:      msg.role,
          content:   msg.content,
          tokens:    msg.tokens,
          ...(msg.parentId  ? { parentId:  msg.parentId  } : {}),
          ...(msg.summaryId ? { summaryId: msg.summaryId } : {}),
        });
      }
    }
  }
}
