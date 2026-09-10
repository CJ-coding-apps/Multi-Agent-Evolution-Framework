import type { SlsaProvenance, SlsaBuilder, SlsaInvocation, SlsaMaterial } from '@maf/types';

export interface ProvenanceOptions {
  builder:    SlsaBuilder;
  invocation: SlsaInvocation;
  materials:  SlsaMaterial[];
}

export class ProvenanceBuilder {
  build(opts: ProvenanceOptions): SlsaProvenance {
    return {
      buildType:  'https://maf.dev/build/v1',
      builder:    opts.builder,
      invocation: opts.invocation,
      materials:  opts.materials,
      runEnv: {
        platform:    process.platform,
        nodeVersion: process.version,
        timestamp:   new Date().toISOString(),
      },
    };
  }

  static forAdapter(
    adapterName: string,
    adapterVersion: string,
    modelVersion: string,
    configUri: string,
    configSha256: string,
    materials: SlsaMaterial[] = [],
  ): SlsaProvenance {
    return new ProvenanceBuilder().build({
      builder: {
        id:           `@maf/adapter-${adapterName}@${adapterVersion}`,
        modelVersion,
      },
      invocation: {
        configSource: { uri: configUri, digest: { sha256: configSha256 } },
        parameters:   {},
        environment:  { platform: process.platform, nodeVersion: process.version },
      },
      materials,
    });
  }
}
