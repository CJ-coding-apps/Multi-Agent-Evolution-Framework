import type {
  RunId, TaskId, AgentId, ToolPlugin, ToolContext, ToolInput, ToolResult,
  PolicyEngineHandle, AttestorHandle, LoopState, LoopPhase, CircuitBreakerConfig,
} from '@maf/types';
import { makeAgentId } from '@maf/types';
import type { RollbackManager } from '@maf/git-ops';
import { PolicyViolationError } from '@maf/policy-engine';
import { CircuitBreaker, CircuitBreakerError } from './CircuitBreaker.js';
import { executeToolGated } from './gatedExec.js';

export interface ToolLoopConfig {
  runId:          RunId;
  taskId:         TaskId;
  cwd:            string;
  projectRoot:    string;
  sessionId:      string;
  worktreePath?:  string;
  agentRole?:     string;
  circuit:        CircuitBreakerConfig;
  policy:         PolicyEngineHandle;
  attestor:       AttestorHandle;
  rollback:       RollbackManager;
}

export type ToolDispatch = (
  toolName: string,
  input: ToolInput,
  ctx: ToolContext,
) => Promise<ToolResult>;

export class ToolLoop {
  private state: LoopState;
  private breaker: CircuitBreaker;
  private agentId: AgentId;

  constructor(private readonly config: ToolLoopConfig) {
    this.agentId = makeAgentId(`tool-loop-${config.taskId}`);
    this.breaker = new CircuitBreaker(config.circuit);
    this.state = {
      runId:        config.runId,
      taskId:       config.taskId,
      phase:        'Initializing',
      attempt:      0,
      tokensBudget: config.circuit.tokenBudget,
      tokensUsed:   0,
      errorCount:   0,
      startedAt:    new Date(),
      updatedAt:    new Date(),
    };
  }

  async executeTool(
    tool: ToolPlugin,
    input: ToolInput,
  ): Promise<ToolResult> {
    this.breaker.check();

    const ctx = this.buildContext();
    this.breaker.recordAttempt();
    const result = await executeToolGated(tool, input, ctx, this.config);

    if (result.exitCode !== 0) {
      this.breaker.recordError();
      this.state.errorCount++;
    }

    this.state.updatedAt = new Date();
    return result;
  }

  async runPatchTestCycle(
    patchTool:    ToolPlugin,
    testTool:     ToolPlugin,
    patchInput:   ToolInput,
    maxIterations = 5,
  ): Promise<{ success: boolean; attempts: number; lastTestResult: ToolResult }> {
    this.transition('Executing');
    let lastTestResult!: ToolResult;

    for (let i = 0; i < maxIterations; i++) {
      this.state.attempt = i + 1;
      const checkpoint = await this.config.rollback.checkpoint();

      try {
        // RED: apply patch
        const patchResult = await this.executeTool(patchTool, patchInput);
        if (patchResult.exitCode !== 0) {
          await this.config.rollback.rollbackTo(checkpoint);
          continue;
        }

        // GREEN: run tests
        this.transition('Testing');
        lastTestResult = await this.executeTool(testTool, {});

        if (lastTestResult.exitCode === 0) {
          this.transition('Done');
          return { success: true, attempts: i + 1, lastTestResult };
        }

        // Tests failed — rollback and retry
        this.transition('Retrying');
        await this.config.rollback.rollbackTo(checkpoint);
      } catch (err) {
        if (err instanceof CircuitBreakerError || err instanceof PolicyViolationError) {
          this.transition('Failed');
          throw err;
        }
        await this.config.rollback.rollbackToLast();
        this.transition('Retrying');
      }
    }

    this.transition('Failed');
    return { success: false, attempts: maxIterations, lastTestResult };
  }

  private transition(phase: LoopPhase): void {
    this.state.phase = phase;
    this.state.updatedAt = new Date();
  }

  private buildContext(): ToolContext {
    return {
      cwd:         this.config.cwd,
      projectRoot: this.config.projectRoot,
      runId:       this.config.runId,
      taskId:      this.config.taskId,
      agentId:     this.agentId,
      sessionId:   this.config.sessionId,
      policy:      this.config.policy,
      attestor:    this.config.attestor,
      ...(this.config.worktreePath ? { worktreePath: this.config.worktreePath } : {}),
      ...(this.config.agentRole    ? { agentRole:    this.config.agentRole    } : {}),
    };
  }

  getState(): LoopState { return { ...this.state }; }
}
