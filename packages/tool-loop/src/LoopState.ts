import type { LoopState, LoopPhase, RunId, TaskId } from '@maf/types';

export class LoopStateManager {
  private state: LoopState;

  constructor(runId: RunId, taskId: TaskId, tokenBudget: number) {
    this.state = {
      runId,
      taskId,
      phase:        'Initializing',
      attempt:      0,
      tokensBudget: tokenBudget,
      tokensUsed:   0,
      errorCount:   0,
      startedAt:    new Date(),
      updatedAt:    new Date(),
    };
  }

  transition(phase: LoopPhase): void {
    validateTransition(this.state.phase, phase);
    this.state.phase     = phase;
    this.state.updatedAt = new Date();
  }

  incrementAttempt(): void {
    this.state.attempt++;
    this.state.updatedAt = new Date();
  }

  recordTokens(used: number): void {
    this.state.tokensUsed += used;
    this.state.updatedAt   = new Date();
  }

  recordError(): void {
    this.state.errorCount++;
    this.state.updatedAt = new Date();
  }

  isTerminal(): boolean {
    return this.state.phase === 'Done' || this.state.phase === 'Failed';
  }

  get(): LoopState { return { ...this.state }; }
}

const VALID_TRANSITIONS: Record<LoopPhase, LoopPhase[]> = {
  Initializing: ['Planning', 'Executing', 'Failed'],
  Planning:     ['Executing', 'Failed'],
  Executing:    ['Testing', 'Evaluating', 'Retrying', 'Done', 'Failed'],
  Testing:      ['Evaluating', 'Done', 'Retrying', 'Failed'],
  Evaluating:   ['Done', 'Retrying', 'Failed'],
  Retrying:     ['Planning', 'Executing', 'Failed'],
  Done:         [],
  Failed:       [],
};

function validateTransition(from: LoopPhase, to: LoopPhase): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid loop state transition: ${from} → ${to}`);
  }
}
