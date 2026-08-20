import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BUILD_ATTESTATION_SCHEMA,
  BuildIdentityService,
  type BuildIdentity,
} from './build-attestation';
import {
  inspectRuntimeAdmission,
  RuntimeAdmissionService,
} from './runtime-admission';
import { resolveRuntimeSettings, type RuntimeSettings } from './runtime-environment';
import {
  currentRuntimeReleaseIdentity,
  RuntimeReleaseIdentityService,
  type RuntimeReleaseIdentity,
} from './runtime-release-identity';
import { RuntimeReadinessContributorRegistry } from './runtime-readiness-registry';
import {
  PrismaRuntimeProcessLeaseStore,
  RuntimeProcessLeaseService,
} from './runtime-process-lease';
import { ApiRuntimeProcessHeartbeat } from './runtime-process-heartbeat';
import { ManagedDependencyReadinessContributors } from './managed-dependency-readiness';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';

export const RUNTIME_SETTINGS = Symbol('RUNTIME_SETTINGS');
export const RUNTIME_RELEASE_IDENTITY = Symbol('RUNTIME_RELEASE_IDENTITY');

function buildCompatibilityIdentity(identity: RuntimeReleaseIdentity): BuildIdentity {
  if (!identity.attested) {
    return Object.freeze({
      attested: false,
      schema_version: BUILD_ATTESTATION_SCHEMA,
    });
  }
  return Object.freeze({
    attested: true,
    schema_version: BUILD_ATTESTATION_SCHEMA,
    build_sha: identity.build_sha,
    built_at: identity.built_at,
    artifact_digest: identity.artifact_digest,
    artifact_manifest_digest: identity.artifact_manifest_digest,
    sbom_digest: identity.sbom_digest,
    source_tree_digest: identity.source_tree_digest,
    renderer_digest: identity.renderer_digest,
    migration_revision: identity.migration_revision,
    schema_digest: identity.schema_digest,
  });
}

@Global()
@Module({
  providers: [
    {
      provide: RUNTIME_SETTINGS,
      useFactory: (): RuntimeSettings => resolveRuntimeSettings(process.env),
    },
    {
      provide: RUNTIME_RELEASE_IDENTITY,
      useFactory: (): Promise<RuntimeReleaseIdentity> =>
        currentRuntimeReleaseIdentity(),
    },
    {
      provide: RuntimeReleaseIdentityService,
      inject: [RUNTIME_RELEASE_IDENTITY],
      useFactory: (identity: RuntimeReleaseIdentity) =>
        new RuntimeReleaseIdentityService(identity),
    },
    {
      provide: BuildIdentityService,
      inject: [RUNTIME_RELEASE_IDENTITY],
      useFactory: (identity: RuntimeReleaseIdentity) =>
        new BuildIdentityService(buildCompatibilityIdentity(identity)),
    },
    {
      provide: RuntimeAdmissionService,
      inject: [RUNTIME_SETTINGS, RUNTIME_RELEASE_IDENTITY],
      useFactory: (
        settings: RuntimeSettings,
        identity: RuntimeReleaseIdentity,
      ) =>
        new RuntimeAdmissionService(
          inspectRuntimeAdmission(settings, process.env, identity),
        ),
    },
    RuntimeReadinessContributorRegistry,
    {
      provide: PrismaRuntimeProcessLeaseStore,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaRuntimeProcessLeaseStore(prisma),
    },
    {
      provide: RuntimeProcessLeaseService,
      inject: [PrismaRuntimeProcessLeaseStore, RUNTIME_RELEASE_IDENTITY],
      useFactory: (
        store: PrismaRuntimeProcessLeaseStore,
        identity: RuntimeReleaseIdentity,
      ) => new RuntimeProcessLeaseService(store, { identity }),
    },
    ApiRuntimeProcessHeartbeat,
    ManagedDependencyReadinessContributors,
    RuntimeReadinessService,
  ],
  exports: [
    RUNTIME_SETTINGS,
    BuildIdentityService,
    RuntimeReleaseIdentityService,
    RuntimeAdmissionService,
    RuntimeReadinessContributorRegistry,
    RuntimeProcessLeaseService,
    RuntimeReadinessService,
  ],
})
export class RuntimeModule {}
