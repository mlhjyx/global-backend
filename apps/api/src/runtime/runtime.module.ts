import { Global, Module } from '@nestjs/common';
import { resolve } from 'node:path';
import {
  BuildIdentityService,
  loadBuildIdentity,
  type BuildIdentity,
} from './build-attestation';
import {
  inspectRuntimeAdmission,
  RuntimeAdmissionService,
} from './runtime-admission';
import { resolveRuntimeSettings, type RuntimeSettings } from './runtime-environment';

export const RUNTIME_SETTINGS = Symbol('RUNTIME_SETTINGS');
export const BUILD_IDENTITY = Symbol('BUILD_IDENTITY');

@Global()
@Module({
  providers: [
    {
      provide: RUNTIME_SETTINGS,
      useFactory: (): RuntimeSettings => resolveRuntimeSettings(process.env),
    },
    {
      provide: BUILD_IDENTITY,
      inject: [RUNTIME_SETTINGS],
      useFactory: async (settings: RuntimeSettings): Promise<BuildIdentity> =>
        loadBuildIdentity({
          mode: settings.mode,
          path:
            process.env.BUILD_ATTESTATION_PATH ??
            resolve(__dirname, '..', 'build-attestation.json'),
        }),
    },
    {
      provide: BuildIdentityService,
      inject: [BUILD_IDENTITY],
      useFactory: (identity: BuildIdentity): BuildIdentityService =>
        new BuildIdentityService(identity),
    },
    {
      provide: RuntimeAdmissionService,
      inject: [RUNTIME_SETTINGS, BUILD_IDENTITY],
      useFactory: (
        settings: RuntimeSettings,
        identity: BuildIdentity,
      ): RuntimeAdmissionService => {
        const result = inspectRuntimeAdmission(settings, process.env, identity);
        if ((settings.mode === 'pilot' || settings.mode === 'production') && !result.admitted) {
          const failed = Object.entries(result.checks)
            .filter(([, check]) => check.status === 'failed')
            .map(([name, check]) => `${name}:${check.code ?? 'FAILED'}`)
            .join(',');
          throw new Error(`runtime admission failed: ${failed}`);
        }
        return new RuntimeAdmissionService(result);
      },
    },
  ],
  exports: [RUNTIME_SETTINGS, BuildIdentityService, RuntimeAdmissionService],
})
export class RuntimeModule {}
