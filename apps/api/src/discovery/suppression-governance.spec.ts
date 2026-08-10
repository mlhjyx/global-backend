import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { DiscoveryService } from './discovery.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SUPPRESSION_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const CTX: RequestContext = {
  workspaceId: WORKSPACE_ID,
  userId: 'pilot-compliance-operator',
  roles: ['pilot_compliance'],
};

type SuppressionRow = {
  id: string;
  workspaceId: string;
  type: string;
  value: string;
  reason: string | null;
  protectionClass: 'PREFERENCE' | 'LEGAL';
};

function makeHarness(record: SuppressionRow) {
  let current = { ...record };
  const decisions: Array<Record<string, unknown>> = [];
  const deleteRecord = vi.fn(async () => {
    current = null as unknown as SuppressionRow;
    return record;
  });
  const createDecision = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    ...data,
  }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    suppressionRecord: {
      findUnique: vi.fn(async () => current),
      findMany: vi.fn(async () => [current]),
      delete: deleteRecord,
      upsert: vi.fn(async ({ update }: { update: Partial<SuppressionRow> }) => {
        current = { ...current, ...update };
        return current;
      }),
    },
    suppressionDecision: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_requestId: { requestId: string } } }) =>
        decisions.find((decision) => decision.requestId === where.workspaceId_requestId.requestId) ?? null),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        const candidate = await createDecision({ data: data[0] });
        if (decisions.some((decision) => decision.requestId === candidate.requestId)) return { count: 0 };
        decisions.push(candidate);
        return { count: 1 };
      }),
      create: createDecision,
      findMany: vi.fn(async () => []),
    },
    canonicalCompany: {
      findMany: vi.fn(async ({ where }: { where?: { id?: { gt?: string } } }) =>
        where?.id?.gt
          ? []
          : [{
              id: '66666666-6666-4666-8666-666666666666',
              domain: ' HTTPS://WWW.EXAMPLE.COM/path ',
              name: '  ACME   GmbH ',
            }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    withWorkspace: async (_workspaceId: string, fn: (scoped: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const service = new DiscoveryService(prisma as never, {} as never);
  return { service, tx, deleteRecord, createDecision, current: () => current };
}

function row(protectionClass: SuppressionRow['protectionClass']): SuppressionRow {
  return {
    id: SUPPRESSION_ID,
    workspaceId: WORKSPACE_ID,
    type: 'email',
    value: 'blocked@example.com',
    reason: protectionClass === 'LEGAL' ? 'unsubscribe' : 'manual',
    protectionClass,
  };
}

describe('Suppression governance', () => {
  it('deprecated DELETE 对偏好类只追加 release request，永远不物理删除或解除禁联', async () => {
    const h = makeHarness(row('PREFERENCE'));

    const result = await h.service.removeSuppression(CTX, SUPPRESSION_ID);

    expect(result).toMatchObject({ deleted: false, releaseRequested: true });
    expect(h.deleteRecord).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ id: SUPPRESSION_ID, protectionClass: 'PREFERENCE' });
    expect(h.createDecision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        suppressionId: SUPPRESSION_ID,
        decision: 'RELEASE_REQUESTED',
        reasonCode: 'USER_PREFERENCE_CHANGED',
        actorId: CTX.userId,
      }),
    });
  });

  it('法定 suppression 的普通 release 请求写拒绝审计后返回 409，禁联事实保持不变', async () => {
    const h = makeHarness(row('LEGAL'));

    await expect(h.service.removeSuppression(CTX, SUPPRESSION_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(h.deleteRecord).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ id: SUPPRESSION_ID, protectionClass: 'LEGAL' });
    expect(h.createDecision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedDecision: 'RELEASE_REQUESTED',
        requestedReasonCode: 'USER_PREFERENCE_CHANGED',
        decision: 'RELEASE_REQUEST_DENIED',
        reasonCode: 'LEGAL_SUPPRESSION_IMMUTABLE',
        actorId: CTX.userId,
      }),
    });
  });

  it('法定 release 的同 requestId 不同原始 reason 以 409 fail-closed，并保留首个请求命令', async () => {
    const h = makeHarness(row('LEGAL'));

    await expect(h.service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
    })).rejects.toMatchObject({ response: { error: { code: 'LEGAL_SUPPRESSION_IMMUTABLE' } } });

    await expect(h.service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'BOUNCE_CLASSIFICATION_ERROR',
    })).rejects.toMatchObject({ response: { error: { code: 'IDEMPOTENCY_CONFLICT' } } });

    expect(h.createDecision).toHaveBeenCalledTimes(2);
    expect(h.createDecision.mock.results[0]?.value).toBeDefined();
  });

  it('重复人工写入不能把已有 LEGAL suppression 降级为 manual/PREFERENCE', async () => {
    const h = makeHarness(row('LEGAL'));

    const result = await h.service.addSuppression(CTX, {
      type: 'email',
      value: 'blocked@example.com',
      reason: 'manual',
    });

    expect(result).toMatchObject({ reason: 'unsubscribe', protectionClass: 'LEGAL' });
    expect(h.current()).toMatchObject({ reason: 'unsubscribe', protectionClass: 'LEGAL' });
  });

  it('未知/未来 reason 默认按 LEGAL fail-closed，不能因词表漂移成为可释放偏好类', async () => {
    const h = makeHarness(row('PREFERENCE'));

    const result = await h.service.addSuppression(CTX, {
      type: 'email',
      value: 'blocked@example.com',
      reason: 'future_legal_basis',
    });

    expect(result).toMatchObject({ protectionClass: 'LEGAL' });
    expect(h.current()).toMatchObject({ protectionClass: 'LEGAL' });
  });

  it.each([
    ['email', '   '],
    ['email', 'not-an-email'],
    ['domain', 'https://localhost/path'],
    ['domain', 'https://bad_domain.example/path'],
    ['company_name', '\t\n'],
    ['unknown_type', 'example.com'],
  ])('非法 suppression %s/%j 在任何 DB 调用前 fail-closed', async (type, value) => {
    const withWorkspace = vi.fn();
    const service = new DiscoveryService({ withWorkspace } as never, {} as never);

    await expect(service.addSuppression(CTX, { type, value, reason: 'legal' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['email', ' Sales@EXAMPLE.COM ', 'sales@example.com'],
    ['domain', 'https://www.Example.COM/path?q=1', 'example.com'],
    ['company_name', '  ACME   GmbH  ', 'acme gmbh'],
  ])('suppression %s 在写入与即时匹配前规范化为 %s', async (type, value, canonicalValue) => {
    const h = makeHarness(row('PREFERENCE'));

    await h.service.addSuppression(CTX, { type, value, reason: 'manual' });

    expect(h.tx.suppressionRecord.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_type_value: {
          workspaceId: WORKSPACE_ID,
          type,
          value: canonicalValue,
        },
      },
      create: expect.objectContaining({ type, value: canonicalValue }),
    }));
    if (type === 'domain' || type === 'company_name') {
      expect(h.tx.canonicalCompany.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['66666666-6666-4666-8666-666666666666'] } },
        data: { status: 'SUPPRESSED' },
      });
    }
  });

  it('身份误关联只能追加带 request/actor/reason/time 的 correction 决策，不修改 suppression', async () => {
    const h = makeHarness(row('LEGAL'));

    const result = await h.service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      decision: 'IDENTITY_CORRECTION_REQUESTED',
      reasonCode: 'IDENTITY_MISASSOCIATION',
    });

    expect(result).toMatchObject({
      suppressionId: SUPPRESSION_ID,
      requestId: REQUEST_ID,
      decision: 'IDENTITY_CORRECTION_REQUESTED',
      reasonCode: 'IDENTITY_MISASSOCIATION',
      actorId: CTX.userId,
    });
    expect(h.deleteRecord).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ id: SUPPRESSION_ID, protectionClass: 'LEGAL' });
  });

  it('append-only suppression 与 decision 查询使用稳定 cursor 且服务端硬限制 100 行', async () => {
    const h = makeHarness(row('PREFERENCE'));
    const cursor = '55555555-5555-4555-8555-555555555555';

    const suppressions = await h.service.listSuppressions(CTX, { cursor, limit: 999 });
    const decisions = await h.service.listSuppressionDecisions(CTX, SUPPRESSION_ID, { cursor, limit: 999 });

    expect(h.tx.suppressionRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { id: cursor },
      skip: 1,
      take: 101,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
    expect(h.tx.suppressionDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { id: cursor },
      skip: 1,
      take: 101,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
    expect(suppressions).toMatchObject({ rows: [expect.any(Object)], hasMore: false, nextCursor: null });
    expect(decisions).toEqual({ rows: [], hasMore: false, nextCursor: null });
  });

  it('并发同 requestId 使用 INSERT ON CONFLICT 语义返回同一事实，不因唯一键竞争变成 500', async () => {
    const existing = {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: WORKSPACE_ID,
      suppressionId: SUPPRESSION_ID,
      requestId: REQUEST_ID,
      requestedDecision: 'RELEASE_REQUESTED',
      requestedReasonCode: 'USER_PREFERENCE_CHANGED',
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
      actorId: CTX.userId,
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    };
    const findDecision = vi.fn().mockResolvedValue(existing);
    const createMany = vi.fn(async () => ({ count: 0 }));
    const create = vi.fn(async () => {
      throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
    });
    const tx = {
      suppressionRecord: { findUnique: vi.fn(async () => row('PREFERENCE')) },
      suppressionDecision: { findUnique: findDecision, createMany, create },
    };
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (scoped: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new DiscoveryService(prisma as never, {} as never);

    await expect(service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      requestedDecision: 'RELEASE_REQUESTED',
      requestedReasonCode: 'USER_PREFERENCE_CHANGED',
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
    })).resolves.toEqual(existing);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('同 requestId 的不同 payload/actor 以 409 fail-closed，不覆盖首个事实', async () => {
    const existing = {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: WORKSPACE_ID,
      suppressionId: SUPPRESSION_ID,
      requestId: REQUEST_ID,
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
      actorId: 'different-actor',
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    };
    const tx = {
      suppressionRecord: { findUnique: vi.fn(async () => row('PREFERENCE')) },
      suppressionDecision: {
        createMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => existing),
      },
    };
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (scoped: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new DiscoveryService(prisma as never, {} as never);

    await expect(service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
    })).rejects.toMatchObject({ response: { error: { code: 'IDEMPOTENCY_CONFLICT' } } });
  });

  it('decision/reason 组合在任何 DB 调用前校验并返回 400', async () => {
    const withWorkspace = vi.fn();
    const service = new DiscoveryService({ withWorkspace } as never, {} as never);

    await expect(service.requestSuppressionDecision(CTX, SUPPRESSION_ID, {
      requestId: REQUEST_ID,
      decision: 'IDENTITY_CORRECTION_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
    })).rejects.toMatchObject({ status: 400, response: { error: { code: 'INVALID_REASON' } } });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('company-name suppression 在 SMTP/provider 路由前阻断既有 contact point 验证', async () => {
    const verifyEmail = vi.fn();
    const routeEmailVerification = vi.fn(async () => [{ key: 'smtp_self', verifyEmail }]);
    const company = {
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Acme Pumpen GmbH',
      domain: 'acme-pumpen.de',
      status: 'ENRICHED',
    };
    const point = {
      id: '88888888-8888-4888-8888-888888888888',
      workspaceId: WORKSPACE_ID,
      contactId: '99999999-9999-4999-8999-999999999999',
      type: 'email',
      value: 'info@acme-pumpen.de',
      status: 'UNVERIFIED',
      verifiedAt: null,
      contact: { company },
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      contactPoint: {
        findUnique: vi.fn(async () => point),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...point, ...data })),
      },
      canonicalCompany: { update: vi.fn(async () => ({ ...company, status: 'SUPPRESSED' })) },
      suppressionRecord: {
        findMany: vi.fn(async () => [{ type: 'company_name', value: ' ACME   PUMPEN GmbH ' }]),
      },
      fieldEvidence: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (scoped: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new DiscoveryService(prisma as never, { routeEmailVerification } as never);

    const result = await service.verifyContactPoint(CTX, point.id);

    expect(result).toMatchObject({ status: 'BLOCKED' });
    expect(routeEmailVerification).not.toHaveBeenCalled();
    expect(verifyEmail).not.toHaveBeenCalled();
    expect(tx.canonicalCompany.update).toHaveBeenCalledWith({
      where: { id: company.id },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
  });

  it('SMTP 返回前新增 email suppression 时，提交侧复核将结果降为 BLOCKED', async () => {
    const verifyEmail = vi.fn(async () => ({ status: 'VALID', detail: 'smtp_accepted:250', costCents: 0 }));
    const routeEmailVerification = vi.fn(async () => [{ key: 'smtp_self', verifyEmail }]);
    const company = {
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Acme Pumpen GmbH',
      domain: 'acme-pumpen.de',
      status: 'ENRICHED',
    };
    const point = {
      id: '88888888-8888-4888-8888-888888888888',
      workspaceId: WORKSPACE_ID,
      contactId: '99999999-9999-4999-8999-999999999999',
      type: 'email',
      value: 'info@acme-pumpen.de',
      status: 'UNVERIFIED',
      verifiedAt: null,
      contact: { company },
    };
    let suppressionRead = 0;
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...point, ...data }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      contactPoint: { findUnique: vi.fn(async () => point), update },
      canonicalCompany: { update: vi.fn(async () => ({ ...company, status: 'SUPPRESSED' })) },
      suppressionRecord: {
        findMany: vi.fn(async () => {
          suppressionRead += 1;
          return suppressionRead === 1 ? [] : [{ type: 'email', value: ' INFO@ACME-PUMPEN.DE ' }];
        }),
      },
      fieldEvidence: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (scoped: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new DiscoveryService(prisma as never, { routeEmailVerification } as never);

    const result = await service.verifyContactPoint(CTX, point.id);

    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'BLOCKED' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'BLOCKED' }) }));
  });
});
