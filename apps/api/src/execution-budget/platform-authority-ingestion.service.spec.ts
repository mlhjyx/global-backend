import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importJWK, type JWK } from 'jose';
import {
  EXECUTION_BUDGET_AUTHORITY_AUDIENCE,
  PLATFORM_EXECUTION_BUDGET_AUTHORITY_COMMAND,
  PLATFORM_EXECUTION_BUDGET_AUTHORITY_SCHEMA_VERSION,
  PLATFORM_EXECUTION_BUDGET_PURPOSES,
  type PlatformExecutionBudgetAuthorityUpsertedV1Claims,
} from '@global/contracts';
import { MODULE_METADATA } from '@nestjs/common/constants';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import {
  EXECUTION_BUDGET_PLATFORM_PURPOSES,
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import {
  EXECUTION_BUDGET_GRANT_AUDIENCE,
  ExecutionBudgetGrantVerifier,
} from './execution-budget-grant.verifier';
import { ExecutionBudgetModule } from './execution-budget.module';
import { PlatformExecutionBudgetAuthorityIngestionService } from './platform-authority-ingestion.service';
import { ExecutionBudgetAuthorityReadinessContributors } from '../runtime/managed-dependency-readiness';

const COMPACT_JWS = 'header.payload.signature';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const ACCOUNT_ID = '8cf66f2a-1780-453e-8d7d-f70e36cb22a6';
const JTI = '120a4e9f-0c06-4cb4-8364-b7df51c45a88';
const SCHEDULE_ID = 'acq-sweep';
const SCHEDULE_REQUEST_SHA256 =
  '5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e';
const WORKFLOW_ID = 'platform-acquisition-acq-sweep-20260904t100000z';
const WORKFLOW_RUN_ID = '11111111-1111-4111-8111-111111111111';
const TECHNICAL_POLICY_REVISION =
  '65ea2cd1c4c42c32e0d378940f65ee6a2530090a3077c54597432da7905337ba';
const ISSUER = 'https://control-plane.example.test/';
const AUDIENCE = 'global-backend:execution-budget';

const VALID_CLAIMS = {
  schema_version: 'execution-budget-grant/v1',
  iss: ISSUER,
  aud: AUDIENCE,
  jti: JTI,
  iat: 1_788_472_800,
  nbf: 1_788_472_800,
  exp: 1_788_473_100,
  authority_kind: 'PLATFORM_GRANT',
  purpose: 'platform.acquisition',
  subject_type: 'schedule',
  subject_id: SCHEDULE_ID,
  schedule_id: SCHEDULE_ID,
  schedule_request_sha256: SCHEDULE_REQUEST_SHA256,
  workflow_id: WORKFLOW_ID,
  workflow_run_id: WORKFLOW_RUN_ID,
  technical_policy_revision: TECHNICAL_POLICY_REVISION,
  currency: 'USD',
  unit: 'microusd',
  cap_per_run_microusd: '1',
  campaign_cap_microusd: '1',
  max_runs: '1',
} as const satisfies PlatformExecutionBudgetAuthorityUpsertedV1Claims;

const EXPECTED_INVOCATION = Object.freeze({
  purpose: 'platform.acquisition' as const,
  subjectType: 'schedule' as const,
  subjectId: SCHEDULE_ID,
  scheduleId: SCHEDULE_ID,
  scheduleRequestSha256: SCHEDULE_REQUEST_SHA256,
  workflowId: WORKFLOW_ID,
  workflowRunId: WORKFLOW_RUN_ID,
  technicalPolicyRevision: TECHNICAL_POLICY_REVISION,
});

function verifiedAuthority(): VerifiedExecutionBudgetAuthority {
  return Object.freeze({
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'PLATFORM_GRANT',
    issuer: ISSUER,
    audience: AUDIENCE,
    jti: JTI,
    purpose: 'platform.acquisition',
    workspaceId: null,
    subjectType: 'schedule',
    subjectId: SCHEDULE_ID,
    requestSha256: null,
    scheduleId: SCHEDULE_ID,
    scheduleRequestSha256: SCHEDULE_REQUEST_SHA256,
    workflowId: WORKFLOW_ID,
    workflowRunId: WORKFLOW_RUN_ID,
    technicalPolicyRevision: TECHNICAL_POLICY_REVISION,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: null,
    capPerRunMicrousd: 1n,
    campaignCapMicrousd: 1n,
    maxRuns: 1n,
    tokenSha256: 'b'.repeat(64),
    issuedAt: 1_786_752_000,
    notBefore: 1_786_752_000,
    expiresAt: 1_786_752_300,
  });
}

function serviceWith(
  verifyPlatform: (
    compactJws: string,
  ) => Promise<VerifiedExecutionBudgetAuthority>,
  ingestPlatformAndAdmit: (
    authority: VerifiedExecutionBudgetAuthority,
    expected: typeof EXPECTED_INVOCATION,
  ) => Promise<{
    authorityId: string;
    accountId: string;
    generation: number;
    authorizedCapMicrousd: bigint;
    replay: boolean;
  }>,
): PlatformExecutionBudgetAuthorityIngestionService {
  return new PlatformExecutionBudgetAuthorityIngestionService(
    { verifyPlatform } as ExecutionBudgetGrantVerifier,
    { ingestPlatformAndAdmit } as ExecutionBudgetAuthorityRepository,
  );
}

async function loadSchema(): Promise<Record<string, unknown>> {
  const candidates = [
    resolve(
      process.cwd(),
      '../../packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json',
    ),
    resolve(
      process.cwd(),
      'packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json',
    ),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    'platform-execution-budget-authority-upserted.v1.schema.json not found',
  );
}

async function loadConformanceFixture(): Promise<Record<string, unknown>> {
  const candidates = [
    resolve(
      process.cwd(),
      '../../packages/contracts/events/fixtures/platform-execution-budget-authority-upserted.v1.valid.json',
    ),
    resolve(
      process.cwd(),
      'packages/contracts/events/fixtures/platform-execution-budget-authority-upserted.v1.valid.json',
    ),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('platform authority conformance fixture not found');
}

describe('PlatformExecutionBudgetAuthorityUpserted/v1 contract', () => {
  it('publishes the external registration identity without adding a claim type field', async () => {
    expect(PLATFORM_EXECUTION_BUDGET_AUTHORITY_COMMAND).toBe(
      'PlatformExecutionBudgetAuthorityUpserted/v1',
    );
    expect(PLATFORM_EXECUTION_BUDGET_AUTHORITY_SCHEMA_VERSION).toBe(
      'execution-budget-grant/v1',
    );

    const schema = await loadSchema();
    expect(schema.title).toBe('PlatformExecutionBudgetAuthorityUpsertedV1');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty('type');
    expect(schema.properties).not.toHaveProperty('event_type');
    expect(schema.properties).not.toHaveProperty('command_type');
  });

  it('accepts only the closed signed platform claim shape', async () => {
    const schema = await loadSchema();
    const validate = addFormats(
      new Ajv2020({ allErrors: true, strict: true }),
    ).compile(schema);

    expect(validate(VALID_CLAIMS), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...VALID_CLAIMS, workspace_id: null })).toBe(false);
    expect(validate({ ...VALID_CLAIMS, request_sha256: null })).toBe(false);
    expect(validate({ ...VALID_CLAIMS, cap_microusd: '1' })).toBe(false);
    expect(validate({ ...VALID_CLAIMS, unknown: 'field' })).toBe(false);
  });

  it('machine-binds audience and the complete sorted purpose set across schema, Contracts and verifier types', async () => {
    const schema = await loadSchema();
    const properties = schema.properties as Record<
      string,
      { readonly const?: unknown; readonly enum?: readonly unknown[] }
    >;

    expect(properties.aud?.const).toBe(EXECUTION_BUDGET_AUTHORITY_AUDIENCE);
    expect(EXECUTION_BUDGET_AUTHORITY_AUDIENCE).toBe(
      EXECUTION_BUDGET_GRANT_AUDIENCE,
    );
    expect([...(properties.purpose?.enum ?? [])].sort()).toEqual(
      [...PLATFORM_EXECUTION_BUDGET_PURPOSES].sort(),
    );
    expect([...EXECUTION_BUDGET_PLATFORM_PURPOSES].sort()).toEqual(
      [...PLATFORM_EXECUTION_BUDGET_PURPOSES].sort(),
    );
  });

  it.each(PLATFORM_EXECUTION_BUDGET_PURPOSES)(
    'accepts the contract platform purpose %s in the signed-claims schema',
    async (purpose) => {
      const schema = await loadSchema();
      const validate = addFormats(
        new Ajv2020({ allErrors: true, strict: true }),
      ).compile(schema);

      expect(
        validate({ ...VALID_CLAIMS, purpose }),
        JSON.stringify(validate.errors),
      ).toBe(true);
    },
  );

  it.each([
    ['nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['URN UUID', `urn:uuid:${JTI}`],
    ['wrong version', '120a4e9f-0c06-0cb4-8364-b7df51c45a88'],
    ['wrong variant', '120a4e9f-0c06-4cb4-7364-b7df51c45a88'],
  ])('rejects a non-canonical JTI with %s', async (_name, jti) => {
    const schema = await loadSchema();
    const validate = addFormats(
      new Ajv2020({ allErrors: true, strict: true }),
    ).compile(schema);

    expect(validate({ ...VALID_CLAIMS, jti })).toBe(false);
  });

  it('ships a public-only cross-repository conformance fixture', async () => {
    const schema = await loadSchema();
    const fixture = await loadConformanceFixture();
    const validate = addFormats(
      new Ajv2020({ allErrors: true, strict: true }),
    ).compile(schema);

    expect(fixture.command).toBe(PLATFORM_EXECUTION_BUDGET_AUTHORITY_COMMAND);
    expect(fixture.verification_time).toBe('2026-09-03T22:00:30.000Z');
    expect(fixture.claims).toEqual(VALID_CLAIMS);
    expect(validate(fixture.claims), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(fixture.public_jwk).toMatchObject({
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
    });
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      expect(fixture.public_jwk).not.toHaveProperty(privateField);
    }
    await expect(
      importJWK(fixture.public_jwk as JWK, 'RS256'),
    ).resolves.toBeDefined();
    expect(fixture.expected).toEqual({
      accepted: true,
      authority_kind: 'PLATFORM_GRANT',
      schedule_id: SCHEDULE_ID,
      schedule_request_sha256: SCHEDULE_REQUEST_SHA256,
      workflow_id: WORKFLOW_ID,
      workflow_run_id: WORKFLOW_RUN_ID,
      technical_policy_revision: TECHNICAL_POLICY_REVISION,
      replay_on_exact_redelivery: true,
    });
  });

  it.each([
    ['schema', { schema_version: 'execution-budget-grant/v2' }],
    ['kind', { authority_kind: 'WORKSPACE_GRANT' }],
    ['purpose', { purpose: 'discovery.run' }],
    ['subject', { subject_type: 'campaign' }],
    ['missing schedule request', { schedule_request_sha256: undefined }],
    ['schedule request digest', { schedule_request_sha256: 'not-a-hash' }],
    ['workflow id', { workflow_id: 'workflow\nsecret' }],
    ['workflow run id', { workflow_run_id: 'NOT-A-LOWERCASE-UUID' }],
    ['technical policy', { technical_policy_revision: 'not-a-hash' }],
    ['per-run decimal', { cap_per_run_microusd: '01' }],
    ['campaign decimal', { campaign_cap_microusd: '0' }],
    ['campaign differs from per-run', { campaign_cap_microusd: '2' }],
    ['multiple runs', { max_runs: '2' }],
    ['max-runs decimal', { max_runs: '1.0' }],
    ['issued-at validity', { iat: '1788472800' }],
    ['not-before validity', { nbf: null }],
    ['expiry validity', { exp: 1_788_473_100.5 }],
  ])('rejects an invalid %s claim', async (_name, override) => {
    const schema = await loadSchema();
    const validate = addFormats(
      new Ajv2020({ allErrors: true, strict: true }),
    ).compile(schema);

    const candidate = { ...VALID_CLAIMS, ...override };
    const schemaAccepted = validate(candidate);
    if (override.campaign_cap_microusd === '2') {
      // JSON Schema cannot express cross-field equality. The verified claim
      // shape enforces it after signature verification.
      expect(schemaAccepted).toBe(true);
    } else {
      expect(schemaAccepted).toBe(false);
    }
  });
});

describe('PlatformExecutionBudgetAuthorityIngestionService', () => {
  it('passes only raw compact JWS to the verifier and exact verified plus expected facts to atomic persistence', async () => {
    const authority = verifiedAuthority();
    const verifyPlatform = vi.fn(async () => authority);
    const ingestPlatformAndAdmit = vi.fn(async () => ({
      authorityId: AUTHORITY_ID,
      accountId: ACCOUNT_ID,
      generation: 1,
      authorizedCapMicrousd: 1n,
      replay: false,
    }));

    const result = await serviceWith(
      verifyPlatform,
      ingestPlatformAndAdmit,
    ).ingestAndAdmit({
      compactJws: COMPACT_JWS,
      expected: EXPECTED_INVOCATION,
    });

    expect(verifyPlatform).toHaveBeenCalledWith(COMPACT_JWS);
    expect(ingestPlatformAndAdmit).toHaveBeenCalledWith(
      authority,
      EXPECTED_INVOCATION,
    );
    expect(ingestPlatformAndAdmit).not.toHaveBeenCalledWith(
      expect.objectContaining({ compactJws: COMPACT_JWS }),
      expect.anything(),
    );
    expect(result).toEqual({
      authorityId: AUTHORITY_ID,
      accountId: ACCOUNT_ID,
      generation: 1,
      authorizedCapMicrousd: 1n,
      replay: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      JSON.stringify(result, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(COMPACT_JWS);
  });

  it('propagates exact account replay identity for idempotent ACK-loss recovery', async () => {
    const authority = verifiedAuthority();
    const verifyPlatform = vi.fn(async () => authority);
    const ingestPlatformAndAdmit = vi
      .fn()
      .mockResolvedValueOnce({
        authorityId: AUTHORITY_ID,
        accountId: ACCOUNT_ID,
        generation: 1,
        authorizedCapMicrousd: 1n,
        replay: false,
      })
      .mockResolvedValueOnce({
        authorityId: AUTHORITY_ID,
        accountId: ACCOUNT_ID,
        generation: 1,
        authorizedCapMicrousd: 1n,
        replay: true,
      });
    const service = serviceWith(verifyPlatform, ingestPlatformAndAdmit);
    const input = {
      compactJws: COMPACT_JWS,
      expected: EXPECTED_INVOCATION,
    } as const;

    await expect(service.ingestAndAdmit(input)).resolves.toMatchObject({
      authorityId: AUTHORITY_ID,
      replay: false,
    });
    await expect(service.ingestAndAdmit(input)).resolves.toMatchObject({
      authorityId: AUTHORITY_ID,
      replay: true,
    });
    expect(verifyPlatform).toHaveBeenCalledTimes(2);
    expect(ingestPlatformAndAdmit).toHaveBeenCalledTimes(2);
  });

  it('reduces verifier output to signed claims so a raw compact JWS can never cross the persistence boundary', async () => {
    const authority = {
      ...verifiedAuthority(),
      compactJws: COMPACT_JWS,
      privateTransportEnvelope: 'must-not-persist',
    };
    const ingestPlatformAndAdmit = vi.fn(async () => ({
      authorityId: AUTHORITY_ID,
      accountId: ACCOUNT_ID,
      generation: 1,
      authorizedCapMicrousd: 1n,
      replay: false,
    }));
    const service = serviceWith(
      vi.fn(async () => authority),
      ingestPlatformAndAdmit,
    );

    await service.ingestAndAdmit({
      compactJws: COMPACT_JWS,
      expected: EXPECTED_INVOCATION,
    });

    const persisted = ingestPlatformAndAdmit.mock.calls[0]?.[0];
    expect(persisted).not.toHaveProperty('compactJws');
    expect(persisted).not.toHaveProperty('privateTransportEnvelope');
    expect(persisted).toMatchObject({
      workflowRunId: WORKFLOW_RUN_ID,
      technicalPolicyRevision: TECHNICAL_POLICY_REVISION,
      tokenSha256: 'b'.repeat(64),
    });
  });

  it.each([
    ['unsigned claims JSON', JSON.stringify(VALID_CLAIMS)],
    [
      'serialized wrapper',
      JSON.stringify({
        schema: 'PlatformExecutionBudgetAuthorityUpserted/v1',
        compact_jws: COMPACT_JWS,
      }),
    ],
    [
      'object wrapper',
      {
        schema: 'PlatformExecutionBudgetAuthorityUpserted/v1',
        compact_jws: COMPACT_JWS,
      },
    ],
  ])('rejects %s before persistence', async (_name, input) => {
    const verifier = new ExecutionBudgetGrantVerifier(
      {
        APP_ENVIRONMENT: 'test',
        NODE_ENV: 'test',
        EXECUTION_BUDGET_GRANT_JWKS_URI:
          'https://control-plane.example.test/.well-known/execution-budget-jwks.json',
        EXECUTION_BUDGET_GRANT_ISSUER: ISSUER,
        EXECUTION_BUDGET_GRANT_AUDIENCE: AUDIENCE,
        EXECUTION_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { keyResolver: vi.fn() },
    );
    const ingestPlatformAndAdmit = vi.fn();
    const service = new PlatformExecutionBudgetAuthorityIngestionService(
      verifier,
      {
        ingestPlatformAndAdmit,
      } as unknown as ExecutionBudgetAuthorityRepository,
    );

    await expect(
      service.ingestAndAdmit({
        compactJws: input as string,
        expected: EXPECTED_INVOCATION,
      }),
    ).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID'),
    );
    expect(ingestPlatformAndAdmit).not.toHaveBeenCalled();
  });

  it('fails closed after verification when no deployment-owned platform writer is bound', async () => {
    const authority = verifiedAuthority();
    const prisma = {
      withWorkspace: vi.fn(async () => {
        throw new Error('workspace principal must not be used');
      }),
    } as unknown as PrismaService;
    const repository = new ExecutionBudgetAuthorityRepository(prisma);
    const service = serviceWith(
      vi.fn(async () => authority),
      repository.ingestPlatformAndAdmit.bind(repository),
    );

    await expect(
      service.ingestAndAdmit({
        compactJws: COMPACT_JWS,
        expected: EXPECTED_INVOCATION,
      }),
    ).rejects.toEqual(
      new ExecutionBudgetGrantError(
        'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      ),
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('is registered and exported without a signer, transport or platform writer fallback', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ExecutionBudgetModule,
    ) as readonly unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      ExecutionBudgetModule,
    ) as readonly unknown[];

    expect(providers).toContain(
      PlatformExecutionBudgetAuthorityIngestionService,
    );
    expect(providers).toContain(ExecutionBudgetAuthorityReadinessContributors);
    expect(exports).toContain(PlatformExecutionBudgetAuthorityIngestionService);
    expect(providers).not.toContain(
      'EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE',
    );
  });

  it('retains the concrete PrismaService injection token for application composition', () => {
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        ExecutionBudgetAuthorityRepository,
      )?.[0],
    ).toBe(PrismaService);
  });
});
