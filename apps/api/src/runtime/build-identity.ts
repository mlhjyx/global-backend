export const RUNTIME_IDENTITY_FIELDS = [
  'BUILD_SHA',
  'BUILD_TIME',
  'ARTIFACT_DIGEST',
  'MIGRATION_REVISION',
] as const;
export type RuntimeIdentityField = (typeof RUNTIME_IDENTITY_FIELDS)[number];

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface VerifiedBuildIdentity {
  readonly status: 'VERIFIED';
  readonly buildSha: string;
  readonly buildTime: string;
  readonly artifactDigest: string;
  readonly migrationRevision: string;
  readonly missingFields: readonly [];
}

export interface UnverifiedBuildIdentity {
  readonly status: 'UNVERIFIED';
  readonly buildSha: string | null;
  readonly buildTime: string | null;
  readonly artifactDigest: string | null;
  readonly migrationRevision: string | null;
  readonly missingFields: readonly RuntimeIdentityField[];
}

export type BuildIdentity = VerifiedBuildIdentity | UnverifiedBuildIdentity;

const BUILD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BUILD_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MIGRATION_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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

function validateArtifactDigest(value: string | null): string | null {
  if (value !== null && !ARTIFACT_DIGEST_PATTERN.test(value)) {
    return invalid(
      'ARTIFACT_DIGEST',
      'expected sha256 followed by 64 lowercase hexadecimal bytes',
    );
  }
  return value;
}

function validateMigrationRevision(value: string | null): string | null {
  if (value !== null && !MIGRATION_REVISION_PATTERN.test(value)) {
    return invalid(
      'MIGRATION_REVISION',
      'expected a 1-128 character identifier containing only letters, digits, dot, underscore, or hyphen',
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
    migrationRevision: null,
    missingFields: Object.freeze([...RUNTIME_IDENTITY_FIELDS]),
  });
}

/** Parses build-tool inputs. Runtime admission must load a verified receipt instead. */
export function resolveBuildIdentityInput(
  env: RuntimeEnvironment,
): BuildIdentity {
  const buildSha = validateBuildSha(optionalCanonicalValue(env, 'BUILD_SHA'));
  const buildTime = validateBuildTime(
    optionalCanonicalValue(env, 'BUILD_TIME'),
  );
  const artifactDigest = validateArtifactDigest(
    optionalCanonicalValue(env, 'ARTIFACT_DIGEST'),
  );
  const migrationRevision = validateMigrationRevision(
    optionalCanonicalValue(env, 'MIGRATION_REVISION'),
  );
  const values = {
    BUILD_SHA: buildSha,
    BUILD_TIME: buildTime,
    ARTIFACT_DIGEST: artifactDigest,
    MIGRATION_REVISION: migrationRevision,
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
      migrationRevision: migrationRevision as string,
      missingFields: Object.freeze([]) as readonly [],
    });
  }

  return Object.freeze({
    status: 'UNVERIFIED',
    buildSha,
    buildTime,
    artifactDigest,
    migrationRevision,
    missingFields,
  });
}

export function hasBuildIdentityEnvironment(env: RuntimeEnvironment): boolean {
  return RUNTIME_IDENTITY_FIELDS.some((field) => env[field] !== undefined);
}
