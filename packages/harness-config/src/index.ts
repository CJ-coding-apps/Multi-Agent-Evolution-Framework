export type { HarnessConfig, ProcessorRef, PlannerRecallConfig, HarnessRoleConfig, HarnessRoleSet } from './types.js';
export { HarnessConfigError, HarnessIntegrityError, assertHarnessConfig } from './types.js';
export { canonicalJson, computeHarnessSha, mintHarnessConfig } from './canonicalize.js';
export { HarnessStore, shortSha, resolveHarnessRef, LEGACY_DEFAULT_ID } from './store.js';
export type { HarnessRefOptions, ResolvedHarness } from './store.js';
