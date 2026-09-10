import type { ToolId } from '@maf/types';

export interface RoleConfig {
  role:               string;
  description?:       string;
  systemPrompt?:      string;
  promptFile?:        string;
  allowedTools:       ToolId[];
  policyTag?:         string;
  model?:             string;
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
