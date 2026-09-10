import type { CliAdapter, AdapterName } from '@maf/types';
import { ClaudeAdapter } from '@maf/adapter-claude';
import { GeminiAdapter } from '@maf/adapter-gemini';
import { CodexAdapter } from '@maf/adapter-codex';
import { OllamaAdapter } from '@maf/adapter-ollama';
import { OpenRouterAdapter } from '@maf/adapter-openrouter';

export function createAdapterRegistry(): Map<AdapterName, CliAdapter> {
  const registry = new Map<AdapterName, CliAdapter>();
  registry.set('claude',      new ClaudeAdapter());
  registry.set('gemini',      new GeminiAdapter());
  registry.set('codex',       new CodexAdapter());
  registry.set('ollama',      new OllamaAdapter());
  registry.set('openrouter',  new OpenRouterAdapter());
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
