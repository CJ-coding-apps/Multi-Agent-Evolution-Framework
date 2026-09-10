export { BaseTool, ToolRegistry } from './ToolPlugin.js';
export { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from './plugins/fs.js';
export { GrepTool } from './plugins/grep.js';
export { GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool } from './plugins/git.js';
export { PatchApplyTool, extractDiffPaths } from './plugins/patch.js';
export { TestRunnerTool } from './plugins/test-runner.js';

import { ToolRegistry } from './ToolPlugin.js';
import { FsReadTool, FsWriteTool, FsDeleteTool, FsStatTool, FsListTool } from './plugins/fs.js';
import { GrepTool } from './plugins/grep.js';
import { GitStatusTool, GitDiffTool, GitAddTool, GitCommitTool, GitLogTool, GitResetTool } from './plugins/git.js';
import { PatchApplyTool } from './plugins/patch.js';
import { TestRunnerTool } from './plugins/test-runner.js';

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  [
    new FsReadTool(), new FsWriteTool(), new FsDeleteTool(), new FsStatTool(), new FsListTool(),
    new GrepTool(),
    new GitStatusTool(), new GitDiffTool(), new GitAddTool(), new GitCommitTool(), new GitLogTool(), new GitResetTool(),
    new PatchApplyTool(),
    new TestRunnerTool(),
  ].forEach((t) => reg.register(t));
  return reg;
}
