import type { ToolPlugin, ToolInput, ToolResult } from '@maf/types';
import type { RollbackManager } from '@maf/git-ops';

export interface PatchTestCycleConfig {
  rollback:      RollbackManager;
  maxIterations: number;
  onAttempt?:    (attempt: number) => void;
  onRollback?:   (reason: string) => void;
}

export interface CycleResult {
  success:        boolean;
  attempts:       number;
  lastTestResult: ToolResult;
  phase:          'patch-failed' | 'test-failed' | 'succeeded' | 'exhausted';
}

// RED-GREEN-REFACTOR patch/test cycle (Superpowers TDD pattern)
export class PatchTestCycle {
  constructor(private readonly config: PatchTestCycleConfig) {}

  async run(
    patchTool:  ToolPlugin,
    testTool:   ToolPlugin,
    patchInput: ToolInput,
    executeToolFn: (tool: ToolPlugin, input: ToolInput) => Promise<ToolResult>,
  ): Promise<CycleResult> {
    let lastTestResult: ToolResult = { exitCode: 1, stdout: '', stderr: 'No test run yet', duration: 0, metadata: {} };

    for (let i = 0; i < this.config.maxIterations; i++) {
      this.config.onAttempt?.(i + 1);
      const checkpoint = await this.config.rollback.checkpoint();

      // RED: apply patch
      const patchResult = await executeToolFn(patchTool, patchInput);
      if (patchResult.exitCode !== 0) {
        this.config.onRollback?.('patch failed');
        await this.config.rollback.rollbackTo(checkpoint);
        return { success: false, attempts: i + 1, lastTestResult: patchResult, phase: 'patch-failed' };
      }

      // GREEN: run tests
      lastTestResult = await executeToolFn(testTool, {});
      if (lastTestResult.exitCode === 0) {
        return { success: true, attempts: i + 1, lastTestResult, phase: 'succeeded' };
      }

      // Tests failed — REFACTOR: rollback and retry
      this.config.onRollback?.('tests failed');
      await this.config.rollback.rollbackTo(checkpoint);
    }

    return { success: false, attempts: this.config.maxIterations, lastTestResult, phase: 'exhausted' };
  }
}
