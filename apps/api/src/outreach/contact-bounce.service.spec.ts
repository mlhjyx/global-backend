import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ContactBounceService } from './contact-bounce.service';

/**
 * P1-13 引擎侧：投递回写的状态机与抑制——hard→INVALID+抑制(PREFERENCE)、soft×3→UNKNOWN+24h、
 * complaint→confidence 0+抑制(LEGAL)+状态不变；messageId 幂等无副作用。
 */
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const POINT = '00000000-0000-4000-8000-0000000000bb';
const CONTACT = '00000000-0000-4000-8000-0000000000cc';
const NOW = new Date('2026-11-09T12:00:00.000Z');

interface FakeOptions {
  point?: { type: string; verificationState: string; validSince?: Date | null } | null;
  priorSoftBounces?: number;
  duplicateEvent?: boolean;
}

function fakePrisma(options: FakeOptions = {}) {
  const createdEvents: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const suppressions: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const pointRow =
    options.point === null
      ? null
      : {
          id: POINT,
          type: options.point?.type ?? 'email',
          value: 'info@acme.example',
          contactId: CONTACT,
          verificationState: options.point?.verificationState ?? 'VALID',
          validSince: options.point?.validSince ?? new Date('2026-10-01T00:00:00.000Z'),
          nextReverifyAt: new Date('2027-01-01T00:00:00.000Z'),
        };
  const tx = {
    contactPoint: {
      findUnique: vi.fn(async () => pointRow),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return pointRow;
      }),
    },
    contactPointVerificationEvent: {
      findUnique: vi.fn(async () => (options.duplicateEvent ? { id: 'existing-event' } : null)),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.duplicateEvent) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        createdEvents.push(data);
        return { id: `event-${createdEvents.length}` };
      }),
    },
    suppressionRecord: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        suppressions.push(create);
        return create;
      }),
    },
    fieldEvidence: {
      count: vi.fn(async () => options.priorSoftBounces ?? 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        evidence.push(data);
        return { id: `evidence-${evidence.length}` };
      }),
    },
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  return { prisma, tx, createdEvents, updates, suppressions, evidence };
}

const service = (prisma: unknown) =>
  new ContactBounceService(prisma as never).withClock(() => NOW);

describe('ContactBounceService：hard_bounce', () => {
  it('置 INVALID（清 catch-all）+ suppression(email, bounce, PREFERENCE) + 证据无 PII', async () => {
    const { prisma, updates, suppressions, evidence, createdEvents } = fakePrisma();
    const outcome = await service(prisma).record(WORKSPACE, POINT, {
      event: 'hard_bounce',
      messageId: 'msg-1',
      smtpCode: '550',
    });
    expect(outcome).toEqual({ action: 'invalidated', duplicate: false });
    expect(createdEvents[0]).toMatchObject({ verdict: 'invalid', providerKey: 'smtp_transport' });
    expect(updates[0]).toMatchObject({
      verificationState: 'INVALID',
      status: 'INVALID',
      validSince: null,
      catchAll: 'unknown',
      catchAllClass: null,
      verificationProvider: 'smtp_transport',
      verificationMethod: 'import',
    });
    expect(suppressions[0]).toMatchObject({
      type: 'email',
      value: 'info@acme.example',
      reason: 'bounce',
      protectionClass: 'PREFERENCE',
    });
    const evidenceValue = evidence[0]?.value as Record<string, unknown>;
    expect(evidenceValue).toMatchObject({ event: 'hard_bounce', smtp_code: '550', message_id: 'msg-1' });
    expect(JSON.stringify(evidence[0])).not.toContain('info@acme.example');
    expect(evidence[0]).toMatchObject({ field: 'email.delivery', dataClass: 'green' });
  });
});

describe('ContactBounceService：soft_bounce', () => {
  it('未达 3 次：只记事件与证据，不改点状态', async () => {
    const { prisma, updates, suppressions, evidence } = fakePrisma({ priorSoftBounces: 1 });
    const outcome = await service(prisma).record(WORKSPACE, POINT, {
      event: 'soft_bounce',
      messageId: 'msg-2',
    });
    expect(outcome).toEqual({ action: 'recorded', duplicate: false });
    expect(updates).toHaveLength(0);
    expect(suppressions).toHaveLength(0);
    expect(evidence).toHaveLength(1);
  });

  it('第 3 次：显式降级 UNKNOWN + 24h 后重验（§2.3.6.6，覆盖 VALID 保留语义）', async () => {
    const { prisma, updates } = fakePrisma({ priorSoftBounces: 2 });
    const outcome = await service(prisma).record(WORKSPACE, POINT, {
      event: 'soft_bounce',
      messageId: 'msg-3',
    });
    expect(outcome).toEqual({ action: 'rescheduled', duplicate: false });
    expect(updates[0]).toMatchObject({
      verificationState: 'UNKNOWN',
      status: 'UNVERIFIED',
      validSince: null,
      confidence: 10,
      nextReverifyAt: new Date(NOW.getTime() + 24 * 3_600_000),
    });
  });
});

describe('ContactBounceService：complaint', () => {
  it('状态不变、confidence 归 0、suppression LEGAL、证据动作去 outreach', async () => {
    const { prisma, updates, suppressions, evidence } = fakePrisma();
    const outcome = await service(prisma).record(WORKSPACE, POINT, {
      event: 'complaint',
      messageId: 'msg-4',
    });
    expect(outcome).toEqual({ action: 'suppressed', duplicate: false });
    expect(updates[0]).toEqual({ confidence: 0, lastVerificationEventId: 'event-1' });
    expect(suppressions[0]).toMatchObject({ reason: 'complaint', protectionClass: 'LEGAL' });
    expect(evidence[0]?.allowedActions).toEqual(['display', 'match']);
  });
});

describe('ContactBounceService：幂等与校验', () => {
  it('重复 messageId → duplicate，无任何副作用', async () => {
    const { prisma, updates, suppressions, evidence } = fakePrisma({ duplicateEvent: true });
    const outcome = await service(prisma).record(WORKSPACE, POINT, {
      event: 'hard_bounce',
      messageId: 'msg-dup',
    });
    expect(outcome).toEqual({ action: 'duplicate', duplicate: true });
    expect(updates).toHaveLength(0);
    expect(suppressions).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('点不存在 → 404；非 email → 409；非法 event/messageId → 400', async () => {
    const codes: string[] = [];
    for (const scenario of [
      { prisma: fakePrisma({ point: null }).prisma, input: { event: 'hard_bounce' as const, messageId: 'm' } },
      { prisma: fakePrisma({ point: { type: 'phone' } }).prisma, input: { event: 'hard_bounce' as const, messageId: 'm' } },
      { prisma: fakePrisma().prisma, input: { event: 'weird' as never, messageId: 'm' } },
      { prisma: fakePrisma().prisma, input: { event: 'hard_bounce' as const, messageId: '   ' } },
      { prisma: fakePrisma().prisma, input: { event: 'hard_bounce' as const, messageId: 'm', receivedAt: 'not-a-date' } },
    ]) {
      try {
        await service(scenario.prisma).record(WORKSPACE, POINT, scenario.input as never);
      } catch (error) {
        codes.push(
          (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? 'other',
        );
      }
    }
    expect(codes).toEqual([
      'CONTACT_POINT_NOT_FOUND',
      'CONTACT_BOUNCE_NOT_EMAIL',
      'OUTREACH_BOUNCE_INVALID_EVENT',
      'OUTREACH_BOUNCE_INVALID_MESSAGE_ID',
      'OUTREACH_BOUNCE_INVALID_RECEIVED_AT',
    ]);
  });
});
