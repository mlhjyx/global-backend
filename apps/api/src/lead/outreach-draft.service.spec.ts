import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as RuntimeBridge from '../model-runtime/structured-task-runtime-bridge';
import * as DomainAck from '../durable-results/domain-ack-consumer-bindings';
import { OutreachDraftService } from './outreach-draft.service';

const ctx = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '50000000-0000-4000-8000-000000000001',
  roles: [],
} as never;
const LEAD_ID = '55555555-5555-4555-8555-555555555501';
const REQUEST_SHA = 'a'.repeat(64);

function binding() {
  return {
    authorityId: '30000000-0000-4000-8000-000000000001',
    replay: false,
    scopeKey: '10000000-0000-4000-8000-000000000001',
    accountKey: `outreach.draft:lead:${LEAD_ID}:${REQUEST_SHA}`,
    purpose: 'outreach.draft',
    subjectType: 'lead',
    subjectId: LEAD_ID,
    requestSha256: REQUEST_SHA,
  };
}

function fixture(overrides: {
  decisions?: Array<{ action: string }>;
  lead?: Record<string, unknown> | null;
} = {}) {
  const lead = overrides.lead === undefined
    ? {
        id: LEAD_ID,
        icpId: '60000000-0000-4000-8000-000000000001',
        canonicalCompanyId: '70000000-0000-4000-8000-000000000001',
        fitVerdict: 'match',
        totalScore: 0.81,
        queue: 'recommended',
        scores: {},
        scoreDetail: null,
        decisions: overrides.decisions ?? [{ action: 'accept' }],
      }
    : overrides.lead;
  const tx = {
    lead: { findUnique: vi.fn(async () => lead) },
    icpDefinition: { findUnique: vi.fn(async () => ({ companyId: '80000000-0000-4000-8000-000000000001' })) },
    companyProfile: {
      findUnique: vi.fn(async () => ({
        id: '80000000-0000-4000-8000-000000000001',
        name: 'Acme Pumps',
        website: 'https://acme.test',
        summary: 'German pump maker',
        publicContacts: [],
      })),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => ({
        name: 'Pumpen Handel GmbH',
        domain: 'pumpen-handel.example',
        country: 'DE',
        attributes: { website_profile: { trade_role: 'distributor' } },
      })),
    },
    claim: { findMany: vi.fn(async () => [{ id: 'claim-1', type: 'certification', statement: 'ISO 9001' }]) },
    offering: { findMany: vi.fn(async () => [{ id: 'offering-1', name: 'Pump X', description: null }]) },
    site: {
      findFirst: vi.fn(async () => ({
        // Shape of Site.profile.contact (site-builder profile contract); the website is
        // deliberately absent — the seller website comes from CompanyProfile only.
        profile: {
          contact: { publicEmails: ['sales@acme.test'], whatsappNumbers: ['+4915112345678'] },
        },
      })),
    },
    leadOutreachDraft: {
      findFirst: vi.fn(async () => ({ version: 2 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        createdAt: new Date('2026-10-28T10:00:00.000Z'),
        ...data,
      })),
      findUnique: vi.fn(async () => null),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspace: string, operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx)),
  };
  const authority = { consumeWorkspaceGrant: vi.fn().mockResolvedValue(binding()) };
  const budgetStore = { attestAuthorized: vi.fn().mockResolvedValue(undefined) };
  const service = new OutreachDraftService(
    prisma as never,
    {} as never,
    {} as never,
    authority as never,
    budgetStore as never,
  );
  return { tx, prisma, authority, budgetStore, service };
}

const OUTPUT = {
  subject: 'Erstkontakt',
  body: 'Guten Tag,\n\nwir fertigen Pumpen nach ISO 9001.',
  body_zh: '您好，\n\n我们生产符合 ISO 9001 的泵。',
  used_facts: ['seller.name', 'seller.claim:claim-1', 'buyer.trade_role', 'fit.verdict'],
};
const RECEIPT = { operationId: 'op-1', resultDigest: 'digest-1' };

function stubModel(output: typeof OUTPUT = OUTPUT) {
  return vi
    .spyOn(RuntimeBridge, 'executeStructuredTaskWithRuntime')
    .mockImplementation(async () => ({
      data: output,
      provider: 'openai-compat',
      model: 'deepseek-v4-pro',
      reportedModel: 'deepseek-v4-pro',
      durableReceipt: RECEIPT,
    } as never));
}

function stubAck(
  status: 'APPLIED' | 'REPLAYED' = 'APPLIED',
) {
  return vi
    .spyOn(DomainAck, 'applyDomainAckConsumerTransaction')
    .mockImplementation(async (input: {
      receipt?: unknown;
      transaction: unknown;
      apply: (transaction: unknown) => Promise<unknown>;
    }) => {
      if (status === 'REPLAYED') {
        return { status: 'REPLAYED', ack: {}, value: undefined } as never;
      }
      return {
        status: input.receipt ? 'APPLIED' : 'UNRECEIPTED',
        ack: {},
        value: await input.apply(input.transaction),
      } as never;
    });
}

afterEach(() => vi.restoreAllMocks());

describe('outreach draft generation (BI-15, design §7)', () => {
  it('consumes the workspace grant, attests it and runs the registered task with the fact prompt', async () => {
    const f = fixture();
    const model = stubModel();
    stubAck();

    await f.service.generate(ctx, LEAD_ID, 'compact-jws');

    expect(f.authority.consumeWorkspaceGrant).toHaveBeenCalledWith({
      compactJws: 'compact-jws',
      identity: ctx,
      scope: {
        purpose: 'outreach.draft',
        subjectType: 'lead',
        subjectId: LEAD_ID,
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(f.budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: binding().authorityId,
      scopeKey: binding().scopeKey,
      accountKey: binding().accountKey,
    });
    const [gateway, input, context] = model.mock.calls[0] as unknown as [
      unknown,
      { task: string; model: string; prompt: string; system: string; schema: unknown },
      { runId: string; durableResultSchema: string; workspaceId: string },
    ];
    void gateway;
    expect(input.task).toBe('outreach.first_contact_draft');
    expect(input.model).toBe('deepseek-flash');
    expect(input.prompt).toContain('德语（Deutsch）（de）');
    expect(input.prompt).toContain('- seller.name: Acme Pumps');
    expect(input.prompt).toContain('- seller.claim:claim-1: [certification] ISO 9001');
    expect(input.prompt).toContain('- buyer.name: Pumpen Handel GmbH');
    expect(input.prompt).toContain('- buyer.trade_role: distributor');
    expect(input.prompt).not.toContain('sales@acme.test');
    expect(context).toMatchObject({
      runId: binding().accountKey,
      durableResultSchema: 'outreach-first-contact-draft/v1',
      workspaceId: ctx.workspaceId,
    });
  });

  it('appends the next version with the seller reply entry and the normalized fact keys', async () => {
    const f = fixture();
    stubModel();
    const ack = stubAck();

    const draft = await f.service.generate(ctx, LEAD_ID);

    expect(f.tx.leadOutreachDraft.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ctx.workspaceId,
        leadId: LEAD_ID,
        version: 3,
        language: 'de',
        subject: 'Erstkontakt',
        body:
          OUTPUT.body +
          '\n\n' +
          [
            '—',
            'Reply directly to Acme Pumps:',
            'Website: https://acme.test',
            'Email: sales@acme.test',
            'WhatsApp: https://wa.me/4915112345678',
          ].join('\n'),
        bodyZh: '您好，\n\n我们生产符合 ISO 9001 的泵。',
        usedFacts: ['seller.name', 'seller.claim:claim-1', 'buyer.trade_role', 'fit.verdict'],
        model: 'deepseek-v4-pro',
      }),
    });
    expect(draft).toMatchObject({ leadId: LEAD_ID, version: 3, language: 'de' });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        producerId: 'outreach.first_contact_draft',
        receipt: RECEIPT,
        domainAckKey: DomainAck.domainAggregateIdForReceipt(RECEIPT as never, 'outreach.first_contact_draft'),
      }),
    );
  });

  it('discards a draft that cites facts it was not given, and writes nothing', async () => {
    const f = fixture();
    stubModel({ ...OUTPUT, used_facts: ['seller.name', 'made.up'] });
    const ack = stubAck();

    const error = await f.service
      .generate(ctx, LEAD_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      error: { code: 'OUTREACH_DRAFT_UNGROUNDED' },
    });
    expect(f.tx.leadOutreachDraft.create).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('refuses a lead whose latest decision is not an accept, before any model call', async () => {
    const f = fixture({ decisions: [{ action: 'reject' }] });
    const model = stubModel();

    const error = await f.service
      .generate(ctx, LEAD_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      error: { code: 'OUTREACH_DRAFT_LEAD_NOT_ACCEPTED' },
    });
    expect(model).not.toHaveBeenCalled();
  });

  it('returns 404 for a lead the workspace cannot see', async () => {
    const f = fixture({ lead: null });
    const error = await f.service
      .generate(ctx, LEAD_ID)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('returns the stored draft when the receipt was already applied (replay)', async () => {
    const f = fixture();
    stubModel();
    stubAck('REPLAYED');
    f.tx.leadOutreachDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      leadId: LEAD_ID,
      version: 1,
      language: 'de',
      subject: 'Erstkontakt',
      body: 'body',
      bodyZh: '译文',
      usedFacts: ['seller.name'],
      model: 'deepseek-v4-pro',
      createdAt: new Date('2026-10-28T09:00:00.000Z'),
    });

    const draft = await f.service.generate(ctx, LEAD_ID);

    expect(f.tx.leadOutreachDraft.create).not.toHaveBeenCalled();
    expect(draft).toMatchObject({ id: 'draft-1', version: 1 });
  });

  it('answers a retryable conflict when the version keeps moving under it', async () => {
    const f = fixture();
    stubModel();
    stubAck();
    f.tx.leadOutreachDraft.create.mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {},
      });
    });

    const error = await f.service.generate(ctx, LEAD_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      error: { code: 'OUTREACH_DRAFT_VERSION_CONFLICT' },
    });
    expect(f.tx.leadOutreachDraft.create).toHaveBeenCalledTimes(3);
  });

  it('recomputes the version when a concurrent draft took it first', async () => {
    const f = fixture();
    stubModel();
    stubAck();
    const rows = [
      { version: 2 },
      { version: 3 },
    ];
    f.tx.leadOutreachDraft.findFirst.mockImplementation(async () => rows.shift() ?? { version: 4 });
    f.tx.leadOutreachDraft.create
      .mockImplementationOnce(async () => {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: {},
        });
      })
      .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
        createdAt: new Date('2026-10-28T10:00:00.000Z'),
        ...data,
      }));

    const draft = await f.service.generate(ctx, LEAD_ID);

    expect(f.tx.leadOutreachDraft.create).toHaveBeenCalledTimes(2);
    expect(draft.version).toBe(4);
  });
});
