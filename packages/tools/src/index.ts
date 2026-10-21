export { BaseTool, ToolRegistry } from './ToolPlugin.js';
export { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from './plugins/fs.js';
export { GrepTool } from './plugins/grep.js';
export { GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool, RepositoryRoots } from './plugins/git.js';
export { PatchApplyTool, extractDiffPaths } from './plugins/patch.js';
export { TestRunnerTool } from './plugins/test-runner.js';
export { LcmExpandTool } from './plugins/lcm.js';
export type { LcmExpander, LcmExpansion, LcmExpandedSummary, LcmExpandedMessage } from './plugins/lcm.js';

import { ToolRegistry } from './ToolPlugin.js';
import { LcmExpandTool, type LcmExpander } from './plugins/lcm.js';
import { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from './plugins/fs.js';
import { GrepTool } from './plugins/grep.js';
import { GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool, RepositoryRoots } from './plugins/git.js';
import { PatchApplyTool } from './plugins/patch.js';
import { TestRunnerTool } from './plugins/test-runner.js';

export interface DefaultRegistryOptions {
  /**
   * The project root every call will name. Given, the git tools learn its repository now, before any
   * tool runs, and refuse a call for any other root; left out, they learn each root at its first git call.
   */
  projectRoot?: string;
  /**
   * Resolves a context summary for `lcm.expand` (WP-3.2 F8). Supplied by the run, which owns the
   * LCM store. The tool is registered either way: a role set that allows it must validate against
   * this registry, and a run that mints its harness before opening the archive validates here.
   * Without an expander the tool refuses with "this run has no context archive", which is true,
   * rather than "no such summary", which would be a lie about a summary that exists elsewhere.
   */
  lcmExpand?: LcmExpander;
}

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ToolRegistry {
  const reg = new ToolRegistry();
  // One for all six git tools, so the repository is learned once, not once per tool.
  const repositories = options.projectRoot !== undefined ? RepositoryRoots.bind(options.projectRoot) : new RepositoryRoots();
  [
    new FsReadTool(), new FsWriteTool(), new FsDeleteTool(), new FsStatTool(), new FsListTool(),
    new GrepTool(),
    new GitStatusTool(undefined, repositories), new GitDiffTool(undefined, repositories), new GitAddTool(undefined, repositories),
    new GitCommitTool(undefined, repositories), new GitLogTool(undefined, repositories), new GitResetTool(undefined, repositories),
    new PatchApplyTool(),
    new TestRunnerTool(),
    new LcmExpandTool(options.lcmExpand),
  ].forEach((t) => reg.register(t));
  return reg;
}
