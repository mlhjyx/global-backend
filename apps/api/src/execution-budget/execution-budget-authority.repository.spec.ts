import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const COMPACT_JWS = 'header.payload.signature';

function workspaceAuthority(): VerifiedExecutionBudgetAuthority {
  return {
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.example.test',
    audience: 'global-backend:execution-budget',
    jti: '120a4e9f-0c06-4cb4-8364-b7df51c45a88',
    purpose: 'icp.design',
    workspaceId: WORKSPACE_ID,
    subjectType: 'company',
    subjectId: 'f5ba98f2-a0e2-4e85-b799-e85568877702',
    requestSha256: 'a'.repeat(64),
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: 2_000_000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: 'b'.repeat(64),
    issuedAt: new Date('2026-08-21T00:00:00.000Z'),
    notBefore: new Date('2026-08-21T00:00:01.000Z'),
    expiresAt: new Date('2026-08-21T00:04:00.000Z'),
  };
}

function platformAuthority(): VerifiedExecutionBudgetAuthority {
  return {
    ...workspaceAuthority(),
    authorityKind: 'PLATFORM_GRANT',
    purpose: 'platform.acquisition',
    workspaceId: null,
    requestSha256: null,
    scheduleId: 'acquisition-hourly',
    subjectType: 'schedule',
    subjectId: 'acquisition-hourly',
    capMicrousd: null,
    capPerRunMicrousd: 1_000_000n,
    campaignCapMicrousd: 10_000_000n,
    maxRuns: 10n,
  };
}

function fakeWorkspacePrisma(
  handler: (query: { strings?: readonly string[]; values?: readonly unknown[] }) => Promise<unknown>,
): PrismaService {
  return {
    withWorkspace: vi.fn(async (_workspaceId, callback) =>
      callback({ $queryRaw: vi.fn(handler) } as never),
    ),
  } as unknown as PrismaService;
}

function fakePlatformWriter(
  handler: (query: { strings?: readonly string[]; values?: readonly unknown[] }) => Promise<unknown>,
): PrismaClient {
  return {
    $transaction: vi.fn(async (callback) =>
      callback({ $queryRaw: vi.fn(handler) } as never),
    ),
  } as unknown as PrismaClient;
}

function rawQueryMarkerError(
  marker: string,
  options?: { prismaCode?: string; sqlState?: string; metaMessage?: string },
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('raw query failed', {
    code: options?.prismaCode ?? 'P2010',
    clientVersion: 'test',
    meta: {
      code: options?.sqlState ?? 'P0001',
      message: options?.metaMessage ?? `ERROR: ${marker}`,
    },
  });
}

describe('ExecutionBudgetAuthorityRepository', () => {
  it('consumes verified workspace claims with parameterized SQL and returns exact replay identity', async () => {
    const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
    const responses = [
      [{ authority_id: AUTHORITY_ID, replay: false }],
      [{ authority_id: AUTHORITY_ID, replay: true }],
    ];
    const prisma = fakeWorkspacePrisma(async (query) => {
      queries.push(query);
      return responses.shift() ?? [];
    });
    const repository = new ExecutionBudgetAuthorityRepository(prisma);
    const authority = Object.assign(workspaceAuthority(), { compactJws: COMPACT_JWS });

    await expect(repository.consumeWorkspace(authority)).resolves.toEqual({
      authorityId: AUTHORITY_ID,
      replay: false,
    });
    await expect(repository.consumeWorkspace(authority)).resolves.toEqual({
      authorityId: AUTHORITY_ID,
      replay: true,
    });

    expect(prisma.withWorkspace).toHaveBeenCalledTimes(2);
    expect(prisma.withWorkspace).toHaveBeenNthCalledWith(1, WORKSPACE_ID, expect.any(Function));
    const serializedSql = queries[0]?.strings?.join('') ?? '';
    expect(serializedSql).toContain('consume_workspace_execution_authority');
    expect(serializedSql).not.toContain(authority.tokenSha256);
    expect(serializedSql).not.toContain(COMPACT_JWS);
    expect(queries[0]?.values).toEqual([
      authority.issuer,
      authority.audience,
      authority.jti,
      authority.tokenSha256,
      authority.schemaVersion,
      authority.purpose,
      authority.workspaceId,
      authority.subjectType,
      authority.subjectId,
      authority.requestSha256,
      authority.currency,
      authority.unit,
      authority.capMicrousd,
      authority.issuedAt,
      authority.notBefore,
      authority.expiresAt,
    ]);
    expect(queries[0]?.values).not.toContain(COMPACT_JWS);
  });

  it('treats an exact token digest as replay and a changed digest as JTI reuse', async () => {
    let persistedDigest: unknown;
    const repository = new ExecutionBudgetAuthorityRepository(
      fakeWorkspacePrisma(async (query) => {
        const digest = query.values?.[3];
        if (persistedDigest === undefined) {
          persistedDigest = digest;
          return [{ authority_id: AUTHORITY_ID, replay: false }];
        }
        if (digest !== persistedDigest) {
          throw new Error('EXECUTION_BUDGET_GRANT_REUSED');
        }
        return [{ authority_id: AUTHORITY_ID, replay: true }];
      }),
    );
    const exact = workspaceAuthority();

    await expect(repository.consumeWorkspace(exact)).resolves.toMatchObject({ replay: false });
    await expect(repository.consumeWorkspace(exact)).resolves.toMatchObject({ replay: true });
    await expect(
      repository.consumeWorkspace({ ...exact, tokenSha256: 'c'.repeat(64) }),
    ).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED'),
    );
  });

  it('ingests platform authority only through the injected platform-writer transaction', async () => {
    const queryRaw = vi.fn(async () => [{ authority_id: AUTHORITY_ID, replay: false }]);
    const platformWriter = fakePlatformWriter(queryRaw);
    const prisma = fakeWorkspacePrisma(async () => {
      throw new Error('workspace principal must not be used');
    });
    const repository = new ExecutionBudgetAuthorityRepository(prisma, platformWriter);
    const authority = platformAuthority();

    await expect(repository.ingestPlatform(authority)).resolves.toEqual({
      authorityId: AUTHORITY_ID,
      replay: false,
    });

    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(query.strings?.join('')).toContain('ingest_platform_execution_authority');
    expect(query.values).toEqual([
      authority.issuer,
      authority.audience,
      authority.jti,
      authority.tokenSha256,
      authority.schemaVersion,
      authority.purpose,
      authority.subjectType,
      authority.subjectId,
      authority.scheduleId,
      authority.currency,
      authority.unit,
      authority.capPerRunMicrousd,
      authority.campaignCapMicrousd,
      authority.maxRuns,
      authority.issuedAt,
      authority.notBefore,
      authority.expiresAt,
    ]);
  });

  it('fails platform ingestion closed when the deployment-owned writer connection is absent', async () => {
    const prisma = fakeWorkspacePrisma(async () => []);
    const repository = new ExecutionBudgetAuthorityRepository(prisma);

    await expect(repository.ingestPlatform(platformAuthority())).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    'EXECUTION_BUDGET_GRANT_REUSED',
  ] as const)('maps SQL marker %s to the transport-neutral grant error', async (marker) => {
    const repository = new ExecutionBudgetAuthorityRepository(
      fakeWorkspacePrisma(async () => {
        throw rawQueryMarkerError(marker);
      }),
    );

    await expect(repository.consumeWorkspace(workspaceAuthority())).rejects.toEqual(
      new ExecutionBudgetGrantError(marker),
    );
  });

  it.each([
    new Error('EXECUTION_BUDGET_GRANT_EXPIRED'),
    rawQueryMarkerError('EXECUTION_BUDGET_GRANT_EXPIRED', {
      prismaCode: 'P2000',
    }),
    rawQueryMarkerError('EXECUTION_BUDGET_GRANT_EXPIRED', {
      sqlState: '23505',
    }),
    rawQueryMarkerError('EXECUTION_BUDGET_GRANT_EXPIRED', {
      metaMessage: 'ERROR: EXECUTION_BUDGET_GRANT_EXPIRED; injected detail',
    }),
  ])('does not trust marker-like unstructured or non-exact database errors', async (failure) => {
    const repository = new ExecutionBudgetAuthorityRepository(
      fakeWorkspacePrisma(async () => {
        throw failure;
      }),
    );

    await expect(repository.consumeWorkspace(workspaceAuthority())).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
  });

  it('sanitizes unknown database failures into a stable unavailable error', async () => {
    const repository = new ExecutionBudgetAuthorityRepository(
      fakeWorkspacePrisma(async () => {
        throw new Error(`connection failed for token ${COMPACT_JWS}`);
      }),
    );

    await expect(repository.consumeWorkspace(workspaceAuthority())).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
  });

  it('appends a workspace-scoped revocation using only parameter values', async () => {
    const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
    const prisma = fakeWorkspacePrisma(async (query) => {
      queries.push(query);
      return 1;
    });
    const repository = new ExecutionBudgetAuthorityRepository(prisma);
    const revokedAt = new Date('2026-08-21T00:02:00.000Z');

    await expect(
      repository.revoke({
        scopeKey: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        reason: 'CONTROL_PLANE_REVOKED',
        revokedAt,
      }),
    ).resolves.toBeUndefined();

    expect(prisma.withWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(Function));
    expect(queries[0]?.strings?.join('')).toContain('execution_budget_authority_revocation');
    expect(queries[0]?.values).toEqual([
      WORKSPACE_ID,
      AUTHORITY_ID,
      'CONTROL_PLANE_REVOKED',
      revokedAt,
    ]);
  });

  it('rejects platform revocation before any workspace or platform transaction', async () => {
    const prisma = fakeWorkspacePrisma(async () => []);
    const platformWriter = fakePlatformWriter(async () => []);
    const repository = new ExecutionBudgetAuthorityRepository(prisma, platformWriter);

    await expect(repository.revoke({
      scopeKey: 'platform',
      authorityId: AUTHORITY_ID,
      reason: 'CONTROL_PLANE_REVOKED',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'),
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'malformed workspace scope',
      input: { scopeKey: 'not-a-workspace', authorityId: AUTHORITY_ID },
      code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    },
    {
      name: 'malformed authority UUID',
      input: { scopeKey: WORKSPACE_ID, authorityId: 'not-an-authority' },
      code: 'EXECUTION_BUDGET_GRANT_INVALID',
    },
  ] as const)('rejects $name before opening a revocation transaction', async ({ input, code }) => {
    const prisma = fakeWorkspacePrisma(async () => []);
    const repository = new ExecutionBudgetAuthorityRepository(prisma);

    await expect(repository.revoke({
      ...input,
      reason: 'CONTROL_PLANE_REVOKED',
    })).rejects.toEqual(new ExecutionBudgetGrantError(code));
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'workspace UUID',
      authority: { ...workspaceAuthority(), workspaceId: 'not-a-workspace' },
      code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    },
    {
      name: 'workspace JTI UUID',
      authority: { ...workspaceAuthority(), jti: 'not-a-jti' },
      code: 'EXECUTION_BUDGET_GRANT_INVALID',
    },
  ] as const)('validates the $name before workspace persistence', async ({ authority, code }) => {
    const prisma = fakeWorkspacePrisma(async () => []);
    const repository = new ExecutionBudgetAuthorityRepository(prisma);

    await expect(repository.consumeWorkspace(authority)).rejects.toEqual(
      new ExecutionBudgetGrantError(code),
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('validates platform JTI before opening the platform-writer transaction', async () => {
    const prisma = fakeWorkspacePrisma(async () => []);
    const platformWriter = fakePlatformWriter(async () => []);
    const repository = new ExecutionBudgetAuthorityRepository(prisma, platformWriter);

    await expect(repository.ingestPlatform({
      ...platformAuthority(),
      jti: 'not-a-jti',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID'),
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).not.toHaveBeenCalled();
  });
});
