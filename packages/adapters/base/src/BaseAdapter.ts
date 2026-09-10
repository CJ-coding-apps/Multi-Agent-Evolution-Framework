import type {
  CliAdapter, AdapterName, AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult,
} from '@maf/types';

export abstract class BaseAdapter implements CliAdapter {
  abstract readonly name: AdapterName;

  abstract capabilities(): AdapterCapabilities;
  abstract isAvailable(): Promise<boolean>;
  abstract invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult>;

  // Default stream implementation: invoke and yield output as a single chunk
  async *stream(options: AdapterInvokeOptions): AsyncGenerator<string> {
    const result = await this.invoke(options);
    yield result.output;
  }

  protected buildSystemPrompt(base?: string, memoryXml?: string): string {
    const parts: string[] = [];
    if (memoryXml) parts.push(memoryXml);
    if (base) parts.push(base);
    return parts.join('\n\n');
  }

  protected elapsed(startMs: number): number {
    return Date.now() - startMs;
  }
}
