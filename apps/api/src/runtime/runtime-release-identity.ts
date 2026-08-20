import { resolve } from 'node:path';
import {
  BUILD_ATTESTATION_SCHEMA,
  loadBuildIdentity,
  type BuildAttestation,
} from './build-attestation';
import type { RuntimeMode } from './runtime-environment';

export const RUNTIME_RELEASE_IDENTITY_SCHEMA =
  'global-runtime-release-identity/v1' as const;

const OCI_IMAGE_REFERENCE_PATTERN =
  /^[a-z0-9][a-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/;

export type RuntimeReleaseIdentityFailureCode =
  | 'BUILD_ATTESTATION_REQUIRED'
  | 'BUILD_ATTESTATION_INVALID'
  | 'IMAGE_REFERENCE_REQUIRED'
  | 'IMAGE_REFERENCE_INVALID'
  | 'SOURCE_WATCH_NOT_MANAGED'
  | 'TEST_RUNTIME_UNATTESTED';

export type RuntimeReleaseIdentity =
  | ({
      attested: true;
      schema_version: typeof RUNTIME_RELEASE_IDENTITY_SCHEMA;
      image_digest: string;
    } & Omit<BuildAttestation, 'schema_version'>)
  | {
      attested: false;
      schema_version: typeof RUNTIME_RELEASE_IDENTITY_SCHEMA;
      code: RuntimeReleaseIdentityFailureCode;
    };

export class RuntimeReleaseIdentityService {
  constructor(private readonly identity: RuntimeReleaseIdentity) {}

  current(): RuntimeReleaseIdentity {
    return this.identity;
  }
}

let initializedIdentity: Promise<RuntimeReleaseIdentity> | undefined;

export function initializeRuntimeReleaseIdentity(input: {
  mode: RuntimeMode;
  artifactRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeReleaseIdentity> {
  initializedIdentity ??= loadRuntimeReleaseIdentity(input);
  return initializedIdentity;
}

export function currentRuntimeReleaseIdentity(): Promise<RuntimeReleaseIdentity> {
  if (!initializedIdentity) {
    throw new Error('runtime release identity was not initialized before bootstrap');
  }
  return initializedIdentity;
}

function unavailable(
  code: RuntimeReleaseIdentityFailureCode,
): RuntimeReleaseIdentity {
  return Object.freeze({
    attested: false,
    schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
    code,
  });
}

function isMissingAttestation(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    (error instanceof Error && /attestation is required/i.test(error.message))
  );
}

export async function loadRuntimeReleaseIdentity(input: {
  mode: RuntimeMode;
  artifactRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeReleaseIdentity> {
  const env = input.env ?? process.env;
  if (input.mode === 'test') return unavailable('TEST_RUNTIME_UNATTESTED');
  if (env.RUNTIME_EXECUTION_PROFILE === 'source-watch') {
    return unavailable('SOURCE_WATCH_NOT_MANAGED');
  }

  let build: BuildAttestation;
  try {
    const identity = await loadBuildIdentity({
      mode: input.mode,
      artifactRoot: input.artifactRoot,
      path: resolve(input.artifactRoot, 'build-attestation.json'),
    });
    if (!identity.attested) return unavailable('BUILD_ATTESTATION_REQUIRED');
    build = identity;
  } catch (error) {
    return unavailable(
      isMissingAttestation(error)
        ? 'BUILD_ATTESTATION_REQUIRED'
        : 'BUILD_ATTESTATION_INVALID',
    );
  }

  const imageReference = env.RUNTIME_IMAGE_REFERENCE?.trim();
  if (!imageReference) return unavailable('IMAGE_REFERENCE_REQUIRED');
  if (!OCI_IMAGE_REFERENCE_PATTERN.test(imageReference)) {
    return unavailable('IMAGE_REFERENCE_INVALID');
  }
  const imageDigest = imageReference.slice(imageReference.lastIndexOf('@') + 1);

  return Object.freeze({
    attested: true,
    schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
    build_sha: build.build_sha,
    built_at: build.built_at,
    image_digest: imageDigest,
    artifact_digest: build.artifact_digest,
    artifact_manifest_digest: build.artifact_manifest_digest,
    sbom_digest: build.sbom_digest,
    source_tree_digest: build.source_tree_digest,
    renderer_digest: build.renderer_digest,
    migration_revision: build.migration_revision,
    schema_digest: build.schema_digest,
  });
}

export function executableArtifactRoot(dirname: string): string {
  return resolve(dirname, '..');
}
