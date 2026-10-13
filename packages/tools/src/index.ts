export { BaseTool, ToolRegistry } from './ToolPlugin.js';
export { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from './plugins/fs.js';
export { GrepTool } from './plugins/grep.js';
export { GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool, RepositoryRoots } from './plugins/git.js';
export { PatchApplyTool, extractDiffPaths } from './plugins/patch.js';
export { TestRunnerTool } from './plugins/test-runner.js';

import { ToolRegistry } from './ToolPlugin.js';
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
  ].forEach((t) => reg.register(t));
  return reg;
}
