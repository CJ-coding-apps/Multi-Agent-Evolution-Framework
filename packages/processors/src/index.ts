export type {
  HookPoint,
  HarnessEvent,
  TaskStartEvent,
  StepStartEvent,
  BeforeModelEvent,
  ModelResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  StepEndEvent,
  TaskEndEvent,
} from './events.js';
export { ALL_HOOKS, HOOK_CONTRACTS, INTERCEPTABLE } from './events.js';
export {
  Processor,
  StaticProcessorRegistry,
  ContractViolation,
  ProcessorInterrupt,
} from './Processor.js';
export type { ProcessorContext, ProcessorDeps, ProcessorFactory } from './Processor.js';
export { ProcessorPipeline, validateContract } from './ProcessorPipeline.js';
export {
  DEFAULT_BUNDLE_REFS,
  createDefaultProcessorRegistry,
  PolicyAuditProcessor,
  SecretRedactProcessor,
  TranscriptProcessor,
  SecurityGateProcessor,
} from './defaults.js';
// Re-exported from @maf/types, which its other callers (git-ops, adapter-base) already depend
// on, so the scrubber has one home and no package grows a dependency to reach this one.
export {
  redactSecrets, redactCredentials, redactText,
  redactRecord, redactCredentialsRecord,
  DEFAULT_PATTERNS, CREDENTIAL_PATTERNS, ASSIGNMENT_PATTERNS,
} from '@maf/types';
