export { BaseAdapter } from './BaseAdapter.js';
export { spawnAndCollect, spawnStreaming } from './ProcessSpawner.js';
export type { SpawnResult } from './ProcessSpawner.js';
export { FAILURE_TAIL_CHARS, failureTail, turnStdout } from './failure.js';
export {
  TOOL_PROTOCOL, serializeTools, buildTurnSystemPrompt, serializeHistory, parseTurn,
} from './turnProtocol.js';
