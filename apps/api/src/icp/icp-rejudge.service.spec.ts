import { ValidationPipe } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type {
  ExecutionBudgetAuthorityService,
  ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-authority.service';
import type { VerifiedExecutionBudgetAuthority } from '../execution-budget/execution-budget-authority.types';
import { icpRejudgeExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import { IcpController } from './icp.controller';
import { RejudgeIcpLeadsDto } from './icp-rejudge.dto';
import { IcpRejudgeService } from './icp-rejudge.service';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000002';
const AUTHORITY_ID = '30000000-0000-4000-8000-000000000003';
const COMPANY_A = '40000000-0000-4000-8000-000000000004';
const COMPANY_B = '50000000-0000-4000-8000-000000000005';

const CTX: RequestContext = {
  workspaceId: WORKSPACE_ID,
  userId: '60000000-0000-4000-8000-000000000006',
  roles: ['ADMIN'],
  scopes: ['acquisition:read', 'acquisition:write'],
};

function makeVerifiedAuthority(
  scope: ReturnType<typeof icpRejudgeExecutionBudgetRequestScope>,
  capMicrousd = 10_000_000n,
): VerifiedExecutionBudgetAuthority {
  return {
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.test',
    audience: 'global-backend:execution-budget',
    jti: '70000000-0000-4000-8000-000000000007',
    purpose: 'icp.rejudge',
    workspaceId: WORKSPACE_ID,
    subjectType: 'icp',
    subjectId: ICP_ID,
    requestSha256: scope.requestSha256,
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: 'b'.repeat(64),
    issuedAt: 1_700_000_000,
    notBefore: 1_700_000_000,
    expiresAt: 1_700_000_300,
  };
}

function makeBinding(
  authority: VerifiedExecutionBudgetAuthority,
  replay = false,
): ExecutionBudgetBinding {
  return {
    authorityId: AUTHORITY_ID,
    replay,
    scopeKey: WORKSPACE_ID,
    accountKey: `icp.rejudge:icp:${ICP_ID}:${authority.requestSha256}`,
    purpose: 'icp.rejudge',
    subjectType: 'icp',
    subjectId: ICP_ID,
    requestSha256: authority.requestSha256!,
  };
}

function makeHarness(options?: {
  icpStatus?: string | null;
  companies?: Array<Record<string, unknown>>;
  capMicrousd?: bigint;
  replay?: boolean;
}) {
  const outboxCreate = vi.fn(async (input: unknown) => input);
  const icpStatus = options?.icpStatus === undefined ? 'ACTIVE' : options.icpStatus;
  const companies = options?.companies ?? [
    {
      id: COMPANY_A,
      name: 'Effe Energy',
      domain: 'effeenergy.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {},
    },
    {
      id: COMPANY_B,
      name: 'Italsol',
      domain: 'italsolsrl.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {},
    },
  ];
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () =>
        icpStatus === null
          ? null
          : {
              id: ICP_ID,
              workspaceId: WORKSPACE_ID,
              status: icpStatus,
              name: 'IT Solar',
              companyAttributes: { trade_side: 'distributor' },
              exclusions: [],
              targetMarkets: ['IT'],
              company: { name: 'Liansheng', summary: 'Solar' },
            },
      ),
    },
    canonicalCompany: {
      findMany: vi.fn(async () => companies),
    },
    judgmentRecord: {
      findMany: vi.fn(async () => []),
    },
    outboxEvent: {
      create: outboxCreate,
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };

  let verifiedAuthority: VerifiedExecutionBudgetAuthority | undefined;
  const verifyWorkspaceGrant = vi.fn(async (input: { scope: ReturnType<typeof icpRejudgeExecutionBudgetRequestScope> }) => {
    verifiedAuthority = makeVerifiedAuthority(input.scope, options?.capMicrousd ?? 10_000_000n);
    return verifiedAuthority;
  });
  const consumeVerifiedWorkspaceGrantInTransaction = vi.fn(
    async (authority: VerifiedExecutionBudgetAuthority, transaction: unknown) => {
      // Exact parameter order guard (#58 errata #1): authority FIRST, tx SECOND.
      expect(authority).toBe(verifiedAuthority);
      expect(transaction).toBe(tx);
      return makeBinding(authority, options?.replay ?? false);
    },
  );
  const budgets = {
    verifyWorkspaceGrant,
    consumeVerifiedWorkspaceGrantInTransaction,
  } as unknown as ExecutionBudgetAuthorityService;

  const service = new IcpRejudgeService(prisma as never, budgets);
  return { service, prisma, tx, outboxCreate, verifyWorkspaceGrant, consumeVerifiedWorkspaceGrantInTransaction };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IcpRejudgeService', () => {
  it('rejects with 409 INVALID_STATE before verifying or consuming grant when JUDGE_CONTRACT_MODE is not enforce', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'off');
    const harness = makeHarness();

    await expect(
      harness.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-1' }, 'compact-jws'),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'INVALID_STATE' } },
    });
    expect(harness.verifyWorkspaceGrant).not.toHaveBeenCalled();
    expect(harness.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
    expect(harness.outboxCreate).not.toHaveBeenCalled();
  });

  it('rejects includeFresh=true without companyIds with 400 before touching grant or DB', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const harness = makeHarness();

    await expect(
      harness.service.requestRejudge(
        CTX,
        ICP_ID,
        { attemptId: 'att-1', includeFresh: true },
        'compact-jws',
      ),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(harness.verifyWorkspaceGrant).not.toHaveBeenCalled();
    expect(harness.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
  });

  it('does not consume the grant when ICP is missing, non-ACTIVE, has zero candidates, or exceeds cost cap', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');

    const missingIcp = makeHarness({ icpStatus: null });
    await expect(
      missingIcp.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-1' }, 'jws'),
    ).rejects.toMatchObject({ status: 404, response: { error: { code: 'NOT_FOUND' } } });
    expect(missingIcp.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();

    const draftIcp = makeHarness({ icpStatus: 'DRAFT' });
    await expect(
      draftIcp.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-1' }, 'jws'),
    ).rejects.toMatchObject({ status: 409, response: { error: { code: 'INVALID_STATE' } } });
    expect(draftIcp.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();

    const noCandidates = makeHarness({ companies: [] });
    await expect(
      noCandidates.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-1' }, 'jws'),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'NO_REJUDGE_CANDIDATES' } },
    });
    expect(noCandidates.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();

    const capExceeded = makeHarness({ capMicrousd: 100n });
    await expect(
      capExceeded.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-1' }, 'jws'),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'REJUDGE_COST_CAP_EXCEEDED' } },
    });
    expect(capExceeded.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a replayed grant with EXECUTION_BUDGET_GRANT_REUSED without writing an outbox event', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const harness = makeHarness({ replay: true });

    await expect(
      harness.service.requestRejudge(CTX, ICP_ID, { attemptId: 'att-replay' }, 'jws'),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_REUSED' });
    expect(harness.outboxCreate).not.toHaveBeenCalled();
  });

  it('verifies grant, plans batches, atomically consumes (authority, tx) + enqueues LeadRejudgeRequested, and returns 202 envelope payload', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const harness = makeHarness({ capMicrousd: 8_300_000n });

    const result = await harness.service.requestRejudge(
      CTX,
      ICP_ID,
      {
        attemptId: 'canary-it-5',
        batchSize: 1,
        refreshCorroboration: true,
        refreshWebsiteProfile: true,
        companyIds: [COMPANY_B, COMPANY_A],
      },
      'jws-token',
    );

    expect(result).toMatchObject({
      icpId: ICP_ID,
      status: 'ACCEPTED',
      candidateCount: 2,
      batchCount: 2,
      estimatedCostMicros: '19800',
      refreshCorroboration: true,
      refreshWebsiteProfile: true,
    });
    expect(result.rejudgeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(harness.verifyWorkspaceGrant).toHaveBeenCalledTimes(1);
    expect(harness.consumeVerifiedWorkspaceGrantInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        eventType: 'LeadRejudgeRequested',
        schemaVersion: 2,
        aggregateType: 'ICP',
        aggregateId: ICP_ID,
        payload: expect.objectContaining({
          rejudgeId: result.rejudgeId,
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: expect.objectContaining({
            authorityId: AUTHORITY_ID,
            purpose: 'icp.rejudge',
            subjectType: 'icp',
            subjectId: ICP_ID,
            replay: false,
          }),
          batches: [
            { index: 0, companyIds: [COMPANY_A] },
            { index: 1, companyIds: [COMPANY_B] },
          ],
          refreshCorroboration: true,
          refreshWebsiteProfile: true,
        }),
      }),
    });
  });

  it('accepts RejudgeIcpLeadsDto instances produced by NestJS ValidationPipe({ transform: true, whitelist: true }) through IcpController.rejudgeLeads', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const harness = makeHarness({ capMicrousd: 8_300_000n });
    const controller = new IcpController(
      {} as never,
      {} as never,
      undefined,
      harness.service,
    );
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const rawBody = {
      attemptId: 'http-pipe-canary-1',
      maxCompanies: 5,
      batchSize: 5,
      refreshCorroboration: true,
      refreshWebsiteProfile: true,
      companyIds: [COMPANY_A],
    };

    const transformed = (await pipe.transform(rawBody, {
      type: 'body',
      metatype: RejudgeIcpLeadsDto,
    })) as RejudgeIcpLeadsDto;
    expect(Object.getPrototypeOf(transformed)).toBe(RejudgeIcpLeadsDto.prototype);

    const response = await controller.rejudgeLeads(CTX, ICP_ID, transformed, 'jws-token');

    expect(response.data).toMatchObject({
      icpId: ICP_ID,
      status: 'ACCEPTED',
      candidateCount: 2,
      batchCount: 1,
      refreshCorroboration: true,
      refreshWebsiteProfile: true,
    });
    const expectedScope = icpRejudgeExecutionBudgetRequestScope(ICP_ID, rawBody);
    expect(harness.verifyWorkspaceGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          requestSha256: expectedScope.requestSha256,
        }),
      }),
    );

    // Non-DTO rogue class instances and DTOs with unexpected keys must still be rejected fail-closed.
    await expect(
      harness.service.requestRejudge(CTX, ICP_ID, new Date() as never, 'jws-token'),
    ).rejects.toMatchObject({ status: 400 });
    const taintedDto = Object.assign(new RejudgeIcpLeadsDto(), {
      attemptId: 'http-pipe-canary-tainted',
      unexpectedKey: 'boom',
    });
    await expect(
      harness.service.requestRejudge(CTX, ICP_ID, taintedDto, 'jws-token'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
