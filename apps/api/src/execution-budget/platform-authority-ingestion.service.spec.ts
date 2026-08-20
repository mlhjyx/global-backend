import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import { ExecutionBudgetModule } from './execution-budget.module';
import { PlatformExecutionBudgetAuthorityIngestionService } from './platform-authority-ingestion.service';

const COMPACT_JWS = 'header.payload.signature';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const JTI = '120a4e9f-0c06-4cb4-8364-b7df51c45a88';
const SCHEDULE_ID = 'platform-acquisition-hourly';
const ISSUER = 'https://control-plane.example.test/';
const AUDIENCE = 'global-backend:execution-budget';

const VALID_CLAIMS = {
  schema_version: 'execution-budget-grant/v1',
  iss: ISSUER,
  aud: AUDIENCE,
  jti: JTI,
  iat: 1_786_752_000,
  nbf: 1_786_752_000,
  exp: 1_786_752_300,
  authority_kind: 'PLATFORM_GRANT',
  purpose: 'platform.acquisition',
  subject_type: 'schedule',
  subject_id: SCHEDULE_ID,
  schedule_id: SCHEDULE_ID,
  currency: 'USD',
  unit: 'microusd',
  cap_per_run_microusd: '1000000',
  campaign_cap_microusd: '10000000',
  max_runs: '10',
} as const satisfies PlatformExecutionBudgetAuthorityUpsertedV1Claims;

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
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: null,
    capPerRunMicrousd: 1_000_000n,
    campaignCapMicrousd: 10_000_000n,
    maxRuns: 10n,
    tokenSha256: 'b'.repeat(64),
    issuedAt: new Date('2026-08-15T00:00:00.000Z'),
    notBefore: new Date('2026-08-15T00:00:00.000Z'),
    expiresAt: new Date('2026-08-15T00:05:00.000Z'),
  });
}

function serviceWith(
  verifyPlatform: (compactJws: string) => Promise<VerifiedExecutionBudgetAuthority>,
  ingestPlatform: (
    authority: VerifiedExecutionBudgetAuthority,
  ) => Promise<{ authorityId: string; replay: boolean }>,
): PlatformExecutionBudgetAuthorityIngestionService {
  return new PlatformExecutionBudgetAuthorityIngestionService(
    { verifyPlatform } as ExecutionBudgetGrantVerifier,
    { ingestPlatform } as ExecutionBudgetAuthorityRepository,
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

    expect(fixture.command).toBe(
      PLATFORM_EXECUTION_BUDGET_AUTHORITY_COMMAND,
    );
    expect(fixture.claims).toEqual(VALID_CLAIMS);
    expect(validate(fixture.claims), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(fixture.public_jwk).toMatchObject({
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
    });
    expect(fixture.public_jwk).not.toHaveProperty('d');
    expect(fixture.public_jwk).not.toHaveProperty('p');
    expect(fixture.public_jwk).not.toHaveProperty('q');
    expect(fixture.public_jwk).not.toHaveProperty('k');
  });

  it.each([
    ['schema', { schema_version: 'execution-budget-grant/v2' }],
    ['kind', { authority_kind: 'WORKSPACE_GRANT' }],
    ['purpose', { purpose: 'discovery.run' }],
    ['subject', { subject_type: 'campaign' }],
    ['per-run decimal', { cap_per_run_microusd: '01' }],
    ['campaign decimal', { campaign_cap_microusd: '0' }],
    ['max-runs decimal', { max_runs: '1.0' }],
    ['issued-at validity', { iat: '1786752000' }],
    ['not-before validity', { nbf: null }],
    ['expiry validity', { exp: 1_786_752_300.5 }],
  ])('rejects an invalid %s claim', async (_name, override) => {
    const schema = await loadSchema();
    const validate = addFormats(
      new Ajv2020({ allErrors: true, strict: true }),
    ).compile(schema);

    expect(validate({ ...VALID_CLAIMS, ...override })).toBe(false);
  });
});

describe('PlatformExecutionBudgetAuthorityIngestionService', () => {
  it('passes only raw compact JWS to the platform verifier and only verified claims to persistence', async () => {
    const authority = verifiedAuthority();
    const verifyPlatform = vi.fn(async () => authority);
    const ingestPlatform = vi.fn(async () => ({
      authorityId: AUTHORITY_ID,
      replay: false,
    }));

    const result = await serviceWith(verifyPlatform, ingestPlatform).ingest(
      COMPACT_JWS,
    );

    expect(verifyPlatform).toHaveBeenCalledWith(COMPACT_JWS);
    expect(ingestPlatform).toHaveBeenCalledWith(authority);
    expect(ingestPlatform).not.toHaveBeenCalledWith(
      expect.objectContaining({ compactJws: COMPACT_JWS }),
    );
    expect(result).toEqual({ authorityId: AUTHORITY_ID, replay: false });
    expect(JSON.stringify(result)).not.toContain(COMPACT_JWS);
  });

  it('propagates exact repository replay identity for idempotent delivery', async () => {
    const authority = verifiedAuthority();
    const verifyPlatform = vi.fn(async () => authority);
    const ingestPlatform = vi
      .fn()
      .mockResolvedValueOnce({ authorityId: AUTHORITY_ID, replay: false })
      .mockResolvedValueOnce({ authorityId: AUTHORITY_ID, replay: true });
    const service = serviceWith(verifyPlatform, ingestPlatform);

    await expect(service.ingest(COMPACT_JWS)).resolves.toEqual({
      authorityId: AUTHORITY_ID,
      replay: false,
    });
    await expect(service.ingest(COMPACT_JWS)).resolves.toEqual({
      authorityId: AUTHORITY_ID,
      replay: true,
    });
    expect(verifyPlatform).toHaveBeenCalledTimes(2);
    expect(ingestPlatform).toHaveBeenCalledTimes(2);
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
    const ingestPlatform = vi.fn();
    const service = new PlatformExecutionBudgetAuthorityIngestionService(
      verifier,
      { ingestPlatform } as unknown as ExecutionBudgetAuthorityRepository,
    );

    await expect(service.ingest(input as string)).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID'),
    );
    expect(ingestPlatform).not.toHaveBeenCalled();
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
      repository.ingestPlatform.bind(repository),
    );

    await expect(service.ingest(COMPACT_JWS)).rejects.toEqual(
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
    expect(exports).toContain(
      PlatformExecutionBudgetAuthorityIngestionService,
    );
    expect(providers).not.toContain('EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE');
  });
});
