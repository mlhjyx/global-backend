import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveApiBindHost,
  resolveBuildIdentity,
  resolveDeploymentStage,
  resolveRuntimeAdmission,
} from './runtime-admission';

const COMPLETE_IDENTITY = Object.freeze({
  BUILD_SHA: 'a'.repeat(40),
  BUILD_TIME: '2026-08-07T12:34:56.000Z',
  ARTIFACT_DIGEST: `sha256:${'b'.repeat(64)}`,
  MIGRATION_REVISION: '202608070001_runtime_identity',
});

const originalBuildSha = process.env.BUILD_SHA;

afterEach(() => {
  if (originalBuildSha === undefined) delete process.env.BUILD_SHA;
  else process.env.BUILD_SHA = originalBuildSha;
});

describe('runtime deployment-stage admission', () => {
  it('defaults non-production processes to development', () => {
    expect(resolveDeploymentStage({})).toBe('development');
    expect(resolveDeploymentStage({ NODE_ENV: 'test' })).toBe('development');
  });

  it('derives production from NODE_ENV for compatibility', () => {
    expect(resolveDeploymentStage({ NODE_ENV: 'production' })).toBe('production');
  });

  it('accepts an explicit pilot or production stage', () => {
    expect(resolveDeploymentStage({ DEPLOYMENT_STAGE: 'pilot' })).toBe('pilot');
    expect(resolveDeploymentStage({ DEPLOYMENT_STAGE: 'production' })).toBe('production');
  });

  it('refuses an explicit development stage from downgrading NODE_ENV=production', () => {
    expect(() =>
      resolveDeploymentStage({ NODE_ENV: 'production', DEPLOYMENT_STAGE: 'development' }),
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
    expect(() => resolveApiBindHost('pilot', {})).toThrow(/API_BIND_HOST.*pilot/i);
    expect(() => resolveApiBindHost('production', {})).toThrow(
      /API_BIND_HOST.*production/i,
    );
    expect(resolveApiBindHost('pilot', { API_BIND_HOST: '127.0.0.1' })).toBe(
      '127.0.0.1',
    );
  });

  it.each(['', ' ', '0.0.0.0', '::', '::1', 'localhost', '127.0.0.1 ', 'http://127.0.0.1'])(
    'rejects blank, broad, ambiguous, or non-canonical host %j before listen',
    (value) => {
      expect(() =>
        resolveApiBindHost('development', { API_BIND_HOST: value }),
      ).toThrow(/API_BIND_HOST/);
    },
  );
});

describe('injected build identity', () => {
  it('reports an honest incomplete development identity without consulting runtime Git', () => {
    process.env.BUILD_SHA = 'f'.repeat(40);

    expect(resolveBuildIdentity({})).toEqual({
      status: 'UNVERIFIED',
      buildSha: null,
      buildTime: null,
      artifactDigest: null,
      migrationRevision: null,
      missingFields: ['BUILD_SHA', 'BUILD_TIME', 'ARTIFACT_DIGEST', 'MIGRATION_REVISION'],
    });
  });

  it('accepts and returns only a complete canonical injected identity', () => {
    expect(resolveBuildIdentity(COMPLETE_IDENTITY)).toEqual({
      status: 'VERIFIED',
      buildSha: COMPLETE_IDENTITY.BUILD_SHA,
      buildTime: COMPLETE_IDENTITY.BUILD_TIME,
      artifactDigest: COMPLETE_IDENTITY.ARTIFACT_DIGEST,
      migrationRevision: COMPLETE_IDENTITY.MIGRATION_REVISION,
      missingFields: [],
    });
  });

  it.each([
    ['BUILD_SHA', 'abc'],
    ['BUILD_TIME', 'yesterday'],
    ['ARTIFACT_DIGEST', 'b'.repeat(64)],
    ['MIGRATION_REVISION', '../latest'],
  ] as const)('rejects malformed injected %s in every stage', (field, value) => {
    expect(() =>
      resolveBuildIdentity({ ...COMPLETE_IDENTITY, [field]: value }),
    ).toThrow(new RegExp(field));
  });

  it.each(['BUILD_SHA', 'BUILD_TIME', 'ARTIFACT_DIGEST', 'MIGRATION_REVISION'] as const)(
    'rejects blank injected %s rather than treating it as absent',
    (field) => {
      expect(() => resolveBuildIdentity({ ...COMPLETE_IDENTITY, [field]: ' ' })).toThrow(
        new RegExp(field),
      );
    },
  );

  it.each(['pilot', 'production'] as const)(
    'fails %s startup admission when any required identity field is missing',
    (stage) => {
      expect(() =>
        resolveRuntimeAdmission({
          DEPLOYMENT_STAGE: stage,
          API_BIND_HOST: '127.0.0.1',
          ...COMPLETE_IDENTITY,
          BUILD_TIME: undefined,
        }),
      ).toThrow(/BUILD_TIME/);
    },
  );

  it('returns one immutable admitted runtime snapshot', () => {
    const admission = resolveRuntimeAdmission({
      DEPLOYMENT_STAGE: 'pilot',
      API_BIND_HOST: '127.0.0.1',
      ...COMPLETE_IDENTITY,
    });

    expect(admission).toMatchObject({
      deploymentStage: 'pilot',
      apiBindHost: '127.0.0.1',
      buildIdentity: { status: 'VERIFIED' },
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.buildIdentity)).toBe(true);
  });
});
