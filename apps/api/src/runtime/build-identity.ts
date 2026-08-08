export const RUNTIME_IDENTITY_FIELDS = [
  'BUILD_SHA',
  'BUILD_TIME',
  'ARTIFACT_DIGEST',
  'MIGRATION_MANIFEST_DIGEST',
] as const;
export type RuntimeIdentityField = (typeof RUNTIME_IDENTITY_FIELDS)[number];

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export const MIGRATION_MANIFEST_SCHEMA =
  'global-api-migration-manifest/v1' as const;

export interface MigrationManifestEntry {
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationManifest {
  readonly schemaVersion: typeof MIGRATION_MANIFEST_SCHEMA;
  readonly digest: string;
  readonly entries: readonly MigrationManifestEntry[];
}

export interface CompleteBuildIdentityAttestation {
  readonly status: 'VERIFIED';
  readonly buildSha: string;
  readonly buildTime: string;
  readonly artifactDigest: string;
  readonly migrationManifestDigest: string;
  readonly missingFields: readonly [];
}

export interface IncompleteBuildIdentityAttestation {
  readonly status: 'UNVERIFIED';
  readonly buildSha: string | null;
  readonly buildTime: string | null;
  readonly artifactDigest: string | null;
  readonly migrationManifestDigest: string | null;
  readonly missingFields: readonly RuntimeIdentityField[];
}

export type BuildIdentityAttestation =
  | CompleteBuildIdentityAttestation
  | IncompleteBuildIdentityAttestation;

export interface VerifiedBuildIdentity {
  readonly status: 'VERIFIED';
  readonly buildSha: string;
  readonly buildTime: string;
  readonly artifactDigest: string;
  readonly migrationManifestDigest: string;
  readonly migrationManifest: MigrationManifest;
  /** Derived from the final ordered manifest entry; never supplied by a caller. */
  readonly migrationRevision: string;
  readonly missingFields: readonly [];
}

export interface UnverifiedBuildIdentity {
  readonly status: 'UNVERIFIED';
  readonly buildSha: string | null;
  readonly buildTime: string | null;
  readonly artifactDigest: string | null;
  readonly migrationManifestDigest: string | null;
  readonly migrationManifest: null;
  readonly migrationRevision: null;
  readonly missingFields: readonly RuntimeIdentityField[];
}

export type BuildIdentity = VerifiedBuildIdentity | UnverifiedBuildIdentity;

const BUILD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BUILD_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function invalid(name: string, expectation: string): never {
  throw new Error(`${name} is invalid; ${expectation}`);
}

function optionalCanonicalValue(
  env: RuntimeEnvironment,
  name: RuntimeIdentityField,
): string | null {
  const value = env[name];
  if (value === undefined) return null;
  if (value.length === 0 || value.trim() !== value) {
    return invalid(name, 'provide a non-blank canonical value or omit it');
  }
  return value;
}

function validateBuildSha(value: string | null): string | null {
  if (value !== null && !BUILD_SHA_PATTERN.test(value)) {
    return invalid(
      'BUILD_SHA',
      'expected a lowercase 40- or 64-character hexadecimal commit',
    );
  }
  return value;
}

function validateBuildTime(value: string | null): string | null {
  if (
    value !== null &&
    (!BUILD_TIME_PATTERN.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value)
  ) {
    return invalid(
      'BUILD_TIME',
      'expected a canonical UTC ISO-8601 timestamp with milliseconds',
    );
  }
  return value;
}

function validateDigest(
  name: 'ARTIFACT_DIGEST' | 'MIGRATION_MANIFEST_DIGEST',
  value: string | null,
): string | null {
  if (value !== null && !SHA256_DIGEST_PATTERN.test(value)) {
    return invalid(
      name,
      'expected sha256 followed by 64 lowercase hexadecimal bytes',
    );
  }
  return value;
}

export function unverifiedBuildIdentity(): UnverifiedBuildIdentity {
  return Object.freeze({
    status: 'UNVERIFIED',
    buildSha: null,
    buildTime: null,
    artifactDigest: null,
    migrationManifestDigest: null,
    migrationManifest: null,
    migrationRevision: null,
    missingFields: Object.freeze([...RUNTIME_IDENTITY_FIELDS]),
  });
}

/** Parses build-tool inputs. Runtime admission must load a verified receipt instead. */
export function resolveBuildIdentityInput(
  env: RuntimeEnvironment,
): BuildIdentityAttestation {
  const buildSha = validateBuildSha(optionalCanonicalValue(env, 'BUILD_SHA'));
  const buildTime = validateBuildTime(
    optionalCanonicalValue(env, 'BUILD_TIME'),
  );
  const artifactDigest = validateDigest(
    'ARTIFACT_DIGEST',
    optionalCanonicalValue(env, 'ARTIFACT_DIGEST'),
  );
  const migrationManifestDigest = validateDigest(
    'MIGRATION_MANIFEST_DIGEST',
    optionalCanonicalValue(env, 'MIGRATION_MANIFEST_DIGEST'),
  );
  const values = {
    BUILD_SHA: buildSha,
    BUILD_TIME: buildTime,
    ARTIFACT_DIGEST: artifactDigest,
    MIGRATION_MANIFEST_DIGEST: migrationManifestDigest,
  } as const;
  const missingFields = Object.freeze(
    RUNTIME_IDENTITY_FIELDS.filter((field) => values[field] === null),
  );

  if (missingFields.length === 0) {
    return Object.freeze({
      status: 'VERIFIED',
      buildSha: buildSha as string,
      buildTime: buildTime as string,
      artifactDigest: artifactDigest as string,
      migrationManifestDigest: migrationManifestDigest as string,
      missingFields: Object.freeze([]) as readonly [],
    });
  }

  return Object.freeze({
    status: 'UNVERIFIED',
    buildSha,
    buildTime,
    artifactDigest,
    migrationManifestDigest,
    missingFields,
  });
}

export function createVerifiedBuildIdentity(
  attestation: CompleteBuildIdentityAttestation,
  migrationManifest: MigrationManifest,
): VerifiedBuildIdentity {
  const migrationRevision = migrationManifest.entries.at(-1)?.name;
  if (!migrationRevision) {
    throw new Error('migration manifest must contain at least one migration');
  }
  if (migrationManifest.digest !== attestation.migrationManifestDigest) {
    throw new Error(
      'MIGRATION_MANIFEST_DIGEST does not match the migration manifest',
    );
  }
  return Object.freeze({
    ...attestation,
    migrationManifest,
    migrationRevision,
  });
}

export function hasBuildIdentityEnvironment(env: RuntimeEnvironment): boolean {
  return RUNTIME_IDENTITY_FIELDS.some((field) => env[field] !== undefined);
}
