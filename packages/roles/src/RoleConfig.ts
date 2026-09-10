import type { ToolId } from '@maf/types';

export interface RoleConfig {
  role:               string;
  description?:       string;
  systemPrompt?:      string;
  promptFile?:        string;
  allowedTools:       ToolId[];
  policyTag?:         string;
  model?:             string;
  /** 'in-process' routes this role through the gated processor-pipeline loop
   *  instead of a single opaque CLI invocation. Default: 'cli'. */
  execution?:         'cli' | 'in-process';
  timeoutMs?:         number;
  maxToolIterations?: number;
  tokenBudget?:       number;
}

export interface RoleSet {
  version:     1;
  defaultRole: string;
  roles:       RoleConfig[];
}

export interface RoleCatalogEntry {
  role:        string;
  description: string;
}
