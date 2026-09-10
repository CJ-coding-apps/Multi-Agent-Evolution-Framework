export { BaseAdapter } from './BaseAdapter.js';
export { spawnAndCollect, spawnStreaming } from './ProcessSpawner.js';
export type { SpawnResult } from './ProcessSpawner.js';
export {
  TOOL_PROTOCOL, serializeTools, buildTurnSystemPrompt, serializeHistory, parseTurn,
} from './turnProtocol.js';
