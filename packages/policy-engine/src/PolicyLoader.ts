import { readFile } from 'node:fs/promises';
import type { PolicyRule } from '@maf/types';

export class PolicyLoader {
  static async load(yamlPath: string): Promise<PolicyRule[]> {
    let text: string;
    try {
      text = await readFile(yamlPath, 'utf8');
    } catch {
      return [];
    }

    try {
      // Try the 'yaml' package if available (optional dep)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = await (eval('import("yaml")') as Promise<{ parse: (s: string) => unknown }>).catch(() => null);
      if (yaml) {
        const parsed = yaml.parse(text) as { rules?: PolicyRule[] };
        return parsed.rules ?? [];
      }
    } catch { /* fall through */ }

    // JSON fallback (policy files stored as JSON-formatted YAML)
    try {
      const stripped = text.replace(/^\s*#.*$/gm, '').trim();
      const parsed = JSON.parse(stripped) as { rules?: PolicyRule[] };
      return parsed.rules ?? [];
    } catch {
      return [];
    }
  }

  static validate(rules: PolicyRule[]): string[] {
    const errors: string[] = [];
    for (const rule of rules) {
      if (!rule.id)          errors.push(`Rule missing id`);
      if (!rule.action?.kind) errors.push(`Rule "${rule.id}" missing action.kind`);
      if (!rule.predicate)   errors.push(`Rule "${rule.id}" missing predicate`);
    }
    return errors;
  }
}
