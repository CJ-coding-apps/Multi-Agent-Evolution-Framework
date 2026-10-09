import type { CliAdapter, AdapterName } from '@maf/types';
import { ClaudeAdapter } from '@maf/adapter-claude';
import { GeminiAdapter } from '@maf/adapter-gemini';
import { CodexAdapter } from '@maf/adapter-codex';
import { OllamaAdapter } from '@maf/adapter-ollama';
import { OpenRouterAdapter } from '@maf/adapter-openrouter';
import { ScriptedAdapter } from '@maf/eval-harness';

export function createAdapterRegistry(): Map<AdapterName, CliAdapter> {
  const registry = new Map<AdapterName, CliAdapter>();
  registry.set('claude',      new ClaudeAdapter());
  registry.set('gemini',      new GeminiAdapter());
  registry.set('codex',       new CodexAdapter());
  registry.set('ollama',      new OllamaAdapter());
  registry.set('openrouter',  new OpenRouterAdapter());
  // With no script it answers the security gate and the judge and refuses every task; `goldens`
  // builds its own from the corpus's scripted.json, which a registry has no way to know.
  registry.set('scripted',    new ScriptedAdapter());
  return registry;
}

export async function resolveAdapter(
  name: AdapterName,
  registry: Map<AdapterName, CliAdapter>,
): Promise<CliAdapter> {
  const adapter = registry.get(name);
  if (!adapter) throw new Error(`Unknown adapter: ${name}. Available: ${[...registry.keys()].join(', ')}`);
  const available = await adapter.isAvailable();
  if (!available) throw new Error(`Adapter "${name}" is not available on this system. Check CLI is installed or env vars are set.`);
  return adapter;
}
