import { ConflictException } from '@nestjs/common';
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
    suppressionRecord: {
      findUnique: vi.fn(async () => current),
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
    canonicalCompany: { updateMany: vi.fn(async () => ({ count: 0 })) },
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
        decision: 'RELEASE_REQUEST_DENIED',
        reasonCode: 'LEGAL_SUPPRESSION_IMMUTABLE',
        actorId: CTX.userId,
      }),
    });
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

  it('并发同 requestId 使用 INSERT ON CONFLICT 语义返回同一事实，不因唯一键竞争变成 500', async () => {
    const existing = {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: WORKSPACE_ID,
      suppressionId: SUPPRESSION_ID,
      requestId: REQUEST_ID,
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
});
