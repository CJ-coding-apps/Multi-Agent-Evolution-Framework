export type { GoldenTask, GoldenProvenance, VerifierRef } from './GoldenTask.js';
export { GoldenCorpusError, assertGoldenTask, assertGoldenCorpus } from './GoldenTask.js';
export type { VerifierContext, VerifierOutcome } from './verifiers.js';
export { runVerifier, runVerifiers, checkUnmodified } from './verifiers.js';
export type {
  TaskDispatcher, GoldenRunnerOptions, GoldenSuiteResult, GoldenTaskResult,
  AttemptResult, SeesawDecision, RecordedSurface, GoldenRunLimit, ContaminatedAttempt,
} from './GoldenRunner.js';
export { GoldenRunner, seesawDecision } from './GoldenRunner.js';
export { ScoreRecorder } from './ScoreRecorder.js';
export { computeCorpusSha } from './corpusSha.js';
export type { CorpusFingerprints, GuardedCorpusFile } from './corpusGuard.js';
export {
  GUARDED_CORPUS_FILES, CorpusChangedError, assertCorpusUnchanged, changedCorpusFiles, fingerprintCorpus,
} from './corpusGuard.js';
export type { DuplicateFinding, DuplicateKind, DuplicateReport } from './heldoutDuplicates.js';
export {
  NEAR_COPY_MIN_SHARED_GRAMS, NEAR_COPY_REVIEW_THRESHOLD, NEAR_COPY_THRESHOLD, SHINGLE_SIZE,
  findHeldOutDuplicates, identifierTokens, normalizeSource, sequenceSimilarity, sharedShingles,
  shingles, withoutCanary,
} from './heldoutDuplicates.js';
export type { HiddenStoreFile } from './hiddenStore.js';
export {
  HIDDEN_STORE_FILE, HIDDEN_STORE_VERSION, CANARY_PREFIX, hiddenStorePath, hiddenStoreMarkers,
  findHiddenMarkers, loadHiddenStore, readHiddenFile, hiddenPaths, expectationPaths, readExpectations,
  canaryToken, injectCanary, encodeHidden, decodeHidden,
} from './hiddenStore.js';
export type {
  SerializedValue, AssertOp, CheckExpectation, CheckObservation, HiddenCheckResult,
} from './hiddenCheck.js';
export {
  DRIVER_SOURCE, runHiddenCheck, captureExpectations, compareObservations,
} from './hiddenCheck.js';
export type { CorpusSplits, LoadedSplits, SplitName } from './splits.js';
export { SPLITS_FILE, MIN_HELD_OUT, SplitsError, computeSplitsSha, isDeterministicTask, isJudgeScored, loadSplits } from './splits.js';
export type {
  CalibrationCount, CalibrationSelection, CalibrationRecord, CalibrationUsage, CalibrationProbeProjection,
  UnsignedCalibrationRecord, CalibrationCheck,
} from './calibration.js';
export {
  CALIBRATION_FILE, CALIBRATION_RUNS, CALIBRATION_MIN_SELECTED, CALIBRATION_MAX_SELECTED,
  CALIBRATION_SELECTION_SEED, CALIBRATION_RULE, CalibrationError, selectCalibrated, applyCalibration,
  signCalibration, verifyCalibration,
  PROBE_FILE, PROBE_DEFAULT_TASKS, PROBE_SELECTION_SEED,
  CALIBRATION_PROBE_CONFIDENCE, CALIBRATION_PROBE_INTERVAL_LEVEL,
  selectProbeTasks, projectProbe, probePosterior,
} from './calibration.js';
export type {
  HeldOutTestRule, HeldOutTaskPasses, HeldOutDelta, HeldOutGateVerdict,
} from './significance.js';
export { HELD_OUT_RULE, stratifiedPValue, stratifiedGate } from './significance.js';
export type { JudgeVerdict, JudgeDisclosure, ModelRef } from './judge.js';
export {
  JUDGE_SYSTEM_PROMPT, judgePrompt, formatJudgeVerdict, parseJudgeVerdict, describeJudge, makeLlmJudge,
} from './judge.js';
export type {
  ScriptedStep, ScriptedTask, ScriptedExchange, ScriptedEvolution, ScriptedBundle,
} from './ScriptedAdapter.js';
export {
  ScriptedAdapter, SCRIPTED_ADAPTER_NAME, SCRIPTED_JUDGE_RATIONALE, SCRIPTED_FILE,
  loadScriptedBundle, loadScriptedTasks,
} from './ScriptedAdapter.js';
