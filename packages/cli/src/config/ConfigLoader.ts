import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

export interface MafConfig {
  adapter?:     string;
  model?:       string;
  policyPath?:  string;
  worktree?:    boolean;
  lcm?: {
    mode?:           'Upward' | 'Dolt';
    contextThreshold?: number;
    freshTailCount?:   number;
  };
  circuit?: {
    tokenBudget?:  number;
    maxAttempts?:  number;
    maxErrors?:    number;
    rateLimit?:    number;
  };
  dag?: {
    maxConcurrent?: number;
    timeoutMs?:     number;
  };
}

export class ConfigLoader {
  // Reads .maf/config.yaml (or .ralph/config.yaml for backward compat)
  static async load(projectRoot: string): Promise<MafConfig> {
    const candidates = [
      path.join(projectRoot, '.maf', 'config.yaml'),
      path.join(projectRoot, '.maf', 'config.json'),
      path.join(projectRoot, '.ralph', 'config.yaml'),   // Ralph backward compat
      path.join(projectRoot, '.ralph', 'config.json'),
    ];

    for (const candidate of candidates) {
      const cfg = await ConfigLoader.tryRead(candidate);
      if (cfg) return cfg;
    }

    return {};
  }

  private static async tryRead(filePath: string): Promise<MafConfig | null> {
    try {
      await access(filePath);
    } catch {
      return null;
    }

    const text = await readFile(filePath, 'utf8');

    // Try JSON first
    try {
      const stripped = text.replace(/^\s*#.*$/gm, '').trim();
      return JSON.parse(stripped) as MafConfig;
    } catch { /* not JSON */ }

    // Try yaml package if available (optional dep)
    try {
      const yaml = await (eval('import("yaml")') as Promise<{ parse: (s: string) => unknown }>).catch(() => null);
      if (yaml) return yaml.parse(text) as MafConfig;
    } catch { /* not available */ }

    return null;
  }

  static merge(...configs: MafConfig[]): MafConfig {
    return Object.assign({}, ...configs);
  }
}
