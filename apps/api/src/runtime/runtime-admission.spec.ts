import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveApiBindHost,
  resolveApiPort,
  resolveCorsOrigins,
  resolveDeploymentStage,
  resolveRuntimeAdmission,
} from './runtime-admission';
import { resolveBuildIdentityInput } from './build-identity';

const COMPLETE_IDENTITY = Object.freeze({
  BUILD_SHA: 'a'.repeat(40),
  BUILD_TIME: '2026-08-07T12:34:56.000Z',
  ARTIFACT_DIGEST: `sha256:${'b'.repeat(64)}`,
  MIGRATION_MANIFEST_DIGEST: `sha256:${'c'.repeat(64)}`,
});
const SAFE_PILOT_ENV = Object.freeze({
  DEPLOYMENT_STAGE: 'pilot',
  NODE_ENV: 'production',
  API_BIND_HOST: '127.0.0.1',
  CORS_ORIGINS: 'https://app.example.test',
  AUTH_JWKS_URI: 'https://identity.example.test/jwks.json',
  AUTH_ISSUER: 'https://identity.example.test',
  AUTH_AUDIENCE: 'global-api',
  MODEL_GATEWAY_URL: 'https://models.example.test/v1',
  MODEL_GATEWAY_KEY: 'test-key',
  S3_ACCESS_KEY: 'test-access',
  S3_SECRET_KEY: 'test-secret',
  DATA_PROCESSOR_JURISDICTION: 'EU',
  SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
});

const originalBuildSha = process.env.BUILD_SHA;

afterEach(() => {
  if (originalBuildSha === undefined) delete process.env.BUILD_SHA;
  else process.env.BUILD_SHA = originalBuildSha;
});

describe('runtime deployment-stage admission', () => {
  it('requires an explicit deployment stage in every process', () => {
    expect(() => resolveDeploymentStage({})).toThrow(
      /DEPLOYMENT_STAGE.*required/i,
    );
    expect(() => resolveDeploymentStage({ NODE_ENV: 'test' })).toThrow(
      /DEPLOYMENT_STAGE.*required/i,
    );
    expect(() => resolveDeploymentStage({ NODE_ENV: 'production' })).toThrow(
      /DEPLOYMENT_STAGE.*required/i,
    );
  });

  it('accepts an explicit pilot or production stage', () => {
    expect(
      resolveDeploymentStage({
        NODE_ENV: 'production',
        DEPLOYMENT_STAGE: 'pilot',
      }),
    ).toBe('pilot');
  });

  it.each(['pilot', 'production'] as const)(
    'rejects %s when NODE_ENV is absent or not exactly production',
    (stage) => {
      expect(() => resolveDeploymentStage({ DEPLOYMENT_STAGE: stage })).toThrow(
        /NODE_ENV.*production/i,
      );
      expect(() =>
        resolveDeploymentStage({
          DEPLOYMENT_STAGE: stage,
          NODE_ENV: 'prodution',
        }),
      ).toThrow(/NODE_ENV/i);
    },
  );

  it.each(['prodution', 'dev', 'staging', 'Production'])
    ('rejects misspelled NODE_ENV=%j', (nodeEnv) => {
      expect(() =>
        resolveDeploymentStage({
          DEPLOYMENT_STAGE: 'development',
          NODE_ENV: nodeEnv,
        }),
      ).toThrow(/NODE_ENV/);
    });

  it('refuses an explicit development stage from downgrading NODE_ENV=production', () => {
    expect(() =>
      resolveDeploymentStage({
        NODE_ENV: 'production',
        DEPLOYMENT_STAGE: 'development',
      }),
    ).toThrow(/DEPLOYMENT_STAGE.*downgrade/i);
  });

  it.each(['', ' ', 'staging', 'prod', 'Pilot'])(
    'rejects invalid explicit DEPLOYMENT_STAGE=%j',
    (value) => {
      expect(() => resolveDeploymentStage({ DEPLOYMENT_STAGE: value })).toThrow(
        /DEPLOYMENT_STAGE/,
      );
    },
  );
});

describe('API_BIND_HOST admission', () => {
  it('defaults development to the Ubuntu loopback contract', () => {
    expect(resolveApiBindHost('development', {})).toBe('127.0.0.1');
  });

  it('requires an explicit loopback host for pilot and production', () => {
    expect(() => resolveApiBindHost('pilot', {})).toThrow(
      /API_BIND_HOST.*pilot/i,
    );
    expect(() => resolveApiBindHost('production', {})).toThrow(
      /API_BIND_HOST.*production/i,
    );
    expect(resolveApiBindHost('pilot', { API_BIND_HOST: '127.0.0.1' })).toBe(
      '127.0.0.1',
    );
  });

  it.each([
    '',
    ' ',
    '0.0.0.0',
    '::',
    '::1',
    'localhost',
    '127.0.0.1 ',
    'http://127.0.0.1',
  ])(
    'rejects blank, broad, ambiguous, or non-canonical host %j before listen',
    (value) => {
      expect(() =>
        resolveApiBindHost('development', { API_BIND_HOST: value }),
      ).toThrow(/API_BIND_HOST/);
    },
  );
});

describe('port and CORS admission', () => {
  it('uses the development port default and accepts only finite integer TCP ports', () => {
    expect(resolveApiPort({})).toBe(3000);
    expect(resolveApiPort({ PORT: '4010' })).toBe(4010);
  });

  it.each(['', ' ', '0', '65536', '1.5', 'NaN', 'Infinity', '03000'])(
    'rejects invalid PORT=%j',
    (value) => {
      expect(() => resolveApiPort({ PORT: value })).toThrow(/PORT/);
    },
  );

  it('allows development to omit CORS_ORIGINS but requires it in pilot and production', () => {
    expect(resolveCorsOrigins('development', {})).toEqual([]);
    expect(() => resolveCorsOrigins('pilot', {})).toThrow(
      /CORS_ORIGINS.*pilot/i,
    );
    expect(() =>
      resolveCorsOrigins('production', { CORS_ORIGINS: ' ' }),
    ).toThrow(/CORS_ORIGINS.*production/i);
  });

  it('accepts only explicit canonical HTTP origins and returns an immutable de-duplicated list', () => {
    const origins = resolveCorsOrigins('pilot', {
      CORS_ORIGINS:
        'https://app.example.test,http://127.0.0.1:5173,https://app.example.test',
    });
    expect(origins).toEqual([
      'https://app.example.test',
      'http://127.0.0.1:5173',
    ]);
    expect(Object.isFrozen(origins)).toBe(true);
  });

  it.each([
    '*',
    'app.example.test',
    'ftp://app.example.test',
    'https://app.example.test/path',
    'https://user:pass@app.example.test',
    'https://app.example.test,',
  ])('rejects non-origin CORS_ORIGINS entry %j', (value) => {
    expect(() =>
      resolveCorsOrigins('development', { CORS_ORIGINS: value }),
    ).toThrow(/CORS_ORIGINS/);
  });
});

describe('injected build identity', () => {
  it('reports an honest incomplete development identity without consulting runtime Git', () => {
    process.env.BUILD_SHA = 'f'.repeat(40);

    expect(resolveBuildIdentityInput({})).toEqual({
      status: 'UNVERIFIED',
      buildSha: null,
      buildTime: null,
      artifactDigest: null,
      migrationManifestDigest: null,
      missingFields: [
        'BUILD_SHA',
        'BUILD_TIME',
        'ARTIFACT_DIGEST',
        'MIGRATION_MANIFEST_DIGEST',
      ],
    });
  });

  it('accepts and returns only a complete canonical injected identity', () => {
    expect(resolveBuildIdentityInput(COMPLETE_IDENTITY)).toEqual({
      status: 'VERIFIED',
      buildSha: COMPLETE_IDENTITY.BUILD_SHA,
      buildTime: COMPLETE_IDENTITY.BUILD_TIME,
      artifactDigest: COMPLETE_IDENTITY.ARTIFACT_DIGEST,
      migrationManifestDigest: COMPLETE_IDENTITY.MIGRATION_MANIFEST_DIGEST,
      missingFields: [],
    });
  });

  it.each([
    ['BUILD_SHA', 'abc'],
    ['BUILD_TIME', 'yesterday'],
    ['ARTIFACT_DIGEST', 'b'.repeat(64)],
    ['MIGRATION_MANIFEST_DIGEST', '../latest'],
  ] as const)(
    'rejects malformed injected %s in every stage',
    (field, value) => {
      expect(() =>
        resolveBuildIdentityInput({ ...COMPLETE_IDENTITY, [field]: value }),
      ).toThrow(new RegExp(field));
    },
  );

  it.each([
    'BUILD_SHA',
    'BUILD_TIME',
    'ARTIFACT_DIGEST',
    'MIGRATION_MANIFEST_DIGEST',
  ] as const)(
    'rejects blank injected %s rather than treating it as absent',
    (field) => {
      expect(() =>
        resolveBuildIdentityInput({ ...COMPLETE_IDENTITY, [field]: ' ' }),
      ).toThrow(new RegExp(field));
    },
  );

  it.each(['pilot', 'production'] as const)(
    'fails %s startup admission when any required identity field is missing',
    (stage) => {
      expect(() =>
        resolveRuntimeAdmission({
          ...SAFE_PILOT_ENV,
          DEPLOYMENT_STAGE: stage,
          ...COMPLETE_IDENTITY,
          BUILD_TIME: undefined,
        }),
      ).toThrow(/build receipt|BUILD_TIME/i);
    },
  );

  it('never admits pilot from runtime identity env without a verified receipt', () => {
    expect(() =>
      resolveRuntimeAdmission({
        ...SAFE_PILOT_ENV,
        ...COMPLETE_IDENTITY,
      }),
    ).toThrow(/build receipt/i);
  });

  it('returns one immutable development runtime snapshot', () => {
    const admission = resolveRuntimeAdmission({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'development',
      AUTH_ALLOW_DEV_TOKENS: 'true',
    });

    expect(admission.admission).toMatchObject({
      deploymentStage: 'development',
      apiBindHost: '127.0.0.1',
      port: 3000,
      corsOrigins: [],
      buildIdentity: { status: 'UNVERIFIED' },
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.admission)).toBe(true);
    expect(Object.isFrozen(admission.admission.corsOrigins)).toBe(true);
    expect(Object.isFrozen(admission.admission.buildIdentity)).toBe(true);
  });
});
