import { Context } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { PrismaService } from '../prisma/prisma.service';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { BudgetStore } from '../tools/budget-store';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const acknowledgementMocks = vi.hoisted(() => ({
  single: vi.fn(async (input: {
    transaction: unknown;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => ({ status: 'APPLIED', value: await input.apply(input.transaction) })),
  plural: vi.fn(async (input: {
    transaction: unknown;
    acknowledgements: Array<{ producerId: string }>;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => ({
    status: 'APPLIED',
    acknowledgements: input.acknowledgements.map(({ producerId }) => ({
      producerId,
      status: 'APPLIED',
    })),
    value: await input.apply(input.transaction),
  })),
}));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransaction: acknowledgementMocks.single,
  applyDomainAckConsumerTransactions: acknowledgementMocks.plural,
}));

import { createUnderstandingActivities } from './understanding.activities';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = '20000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000001';
const BINDING = Object.freeze({
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `understanding.run:company:request:${'a'.repeat(64)}:${'a'.repeat(64)}`,
  purpose: 'understanding.run' as const,
  subjectType: 'company',
  subjectId: `request:${'a'.repeat(64)}`,
  requestSha256: 'a'.repeat(64),
});
const AUTHORITY_ARGS = Object.freeze({
  workspaceId: WORKSPACE_ID,
  executionContractVersion: 2 as const,
  executionBudget: BINDING,
});

function receipt(input: {
  operationId: string;
  resultStrategy: 'typed_projection' | 'artifact_reference';
  resultSchema: string;
  artifactId?: string | null;
}): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: WORKSPACE_ID,
    authorityId: AUTHORITY_ID,
    accountId: ACCOUNT_ID,
    operationId: input.operationId,
    operationKey: `understanding:${input.resultSchema}`,
    resultStrategy: input.resultStrategy,
    resultSchema: input.resultSchema,
    resultDigest: input.operationId.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    artifactId: input.artifactId ?? null,
    usage: {
      currency: 'USD', unit: 'microusd', callCount: 1,
      upperBoundMicrousd: '10000',
    },
    costBasis: 'estimated_upper_bound',
  });
}

const CRAWL_RECEIPT = receipt({
  operationId: '40000000-0000-4000-8000-000000000001',
  resultStrategy: 'artifact_reference',
  resultSchema: 'crawl4ai-fetch/v1',
  artifactId: '50000000-0000-4000-8000-000000000001',
});
const CLAIM_RECEIPT = receipt({
  operationId: '40000000-0000-4000-8000-000000000002',
  resultStrategy: 'typed_projection',
  resultSchema: 'understanding-claims/v1',
});
const PROFILE_RECEIPT = receipt({
  operationId: '40000000-0000-4000-8000-000000000003',
  resultStrategy: 'typed_projection',
  resultSchema: 'understanding-profile/v1',
});
const OFFERING_RECEIPT = receipt({
  operationId: '40000000-0000-4000-8000-000000000004',
  resultStrategy: 'typed_projection',
  resultSchema: 'understanding-offerings/v1',
});

function budgetStore(): BudgetStore {
  return {
    attestAuthorized: vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      authorityId: AUTHORITY_ID,
      authorizedCapMicrousd: 10000n,
      generation: 1,
    })),
  } as unknown as BudgetStore;
}

describe('understanding receipt consumers', () => {
  it('propagates the crawl artifact receipt into the workflow page payload', async () => {
    const invoke = vi.fn(async () => ({
      data: { text: 'Acme makes pumps.' },
      costCents: 0,
      durableReceipt: CRAWL_RECEIPT,
    }));
    const activities = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
      budgetStore: budgetStore(),
    });

    await expect(activities.crawlWebsite({
      ...AUTHORITY_ARGS,
      website: 'https://acme.example/',
    })).resolves.toEqual({
      url: 'https://acme.example/',
      text: 'Acme makes pumps.',
      durableReceipt: CRAWL_RECEIPT,
    });
  });

  it('ACKs crawl plus Model receipts on the exact claims transaction', async () => {
    acknowledgementMocks.plural.mockClear();
    const current = vi.spyOn(Context, 'current').mockReturnValue({
      info: {
        workflowExecution: { runId: 'understanding-workflow-run' },
        activityId: 'persist-claims',
      },
    } as never);
    const tx = {
      claim: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 'claim-1' })),
        count: vi.fn(async () => 1),
      },
      knowledgeSource: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'source-1' })),
      },
      knowledgeConflict: { create: vi.fn(async () => ({})) },
      outboxEvent: { create: vi.fn(async () => ({})) },
      evidence: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const activities = createUnderstandingActivities({
      prisma: prisma as unknown as PrismaService,
      gateway: {} as ModelGateway,
      budgetStore: budgetStore(),
    });

    await expect(activities.persistClaims({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{
        url: 'https://acme.example/about',
        claims: [{ type: 'product', statement: 'Makes pumps', confidence: 0.9 }],
        durableReceipt: CLAIM_RECEIPT,
        crawlDurableReceipt: CRAWL_RECEIPT,
      }],
    })).resolves.toEqual({ claimCount: 1 });
    expect(acknowledgementMocks.plural).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: tx,
        acknowledgements: [
          expect.objectContaining({
            producerId: 'company_understanding.extract_claims',
            receipt: CLAIM_RECEIPT,
          }),
          expect.objectContaining({
            producerId: 'crawl4ai.fetch',
            receipt: CRAWL_RECEIPT,
          }),
        ],
      }),
    );
    expect(tx.claim.create).toHaveBeenCalledOnce();

    acknowledgementMocks.plural.mockImplementationOnce(async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      readback: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: 'REPLAYED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId, status: 'REPLAYED',
      })),
      value: await input.readback(input.transaction),
    }));
    await expect(activities.persistClaims({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{
        url: 'https://acme.example/about', claims: [],
        durableReceipt: CLAIM_RECEIPT,
      }],
    })).resolves.toEqual({ claimCount: 1 });
    expect(tx.claim.count).toHaveBeenCalledOnce();
    current.mockRestore();
  });

  it('ACKs a valid empty profile result without issuing a fake profile update', async () => {
    acknowledgementMocks.single.mockClear();
    const profileUpdate = vi.fn();
    const tx = { companyProfile: { update: profileUpdate } };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: { industry: '', summary: '' },
        provider: 'gateway',
        model: 'model',
        durableReceipt: PROFILE_RECEIPT,
      })),
    };
    const activities = createUnderstandingActivities({
      prisma: prisma as unknown as PrismaService,
      gateway: gateway as unknown as ModelGateway,
      budgetStore: budgetStore(),
    });

    await expect(activities.extractAndPersistProfile({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      text: 'No profile facts.',
    })).resolves.toBeUndefined();
    expect(acknowledgementMocks.single).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: tx,
        producerId: 'company_understanding.extract_profile',
        receipt: PROFILE_RECEIPT,
      }),
    );
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it('uses authoritative replay readback for offerings and public crawl contacts', async () => {
    const offeringCount = vi.fn(async () => 4);
    const contactUpdate = vi.fn();
    const tx = {
      offering: { upsert: vi.fn(), count: offeringCount },
      companyProfile: {
        update: contactUpdate,
        findUniqueOrThrow: vi.fn(async () => ({
          publicContacts: [{ type: 'email', value: 'info@acme.example' }],
        })),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const activities = createUnderstandingActivities({
      prisma: prisma as unknown as PrismaService,
      gateway: {} as ModelGateway,
      budgetStore: budgetStore(),
    });
    const replay = async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      readback: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: 'REPLAYED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId, status: 'REPLAYED',
      })),
      value: await input.readback(input.transaction),
    });
    acknowledgementMocks.plural.mockImplementationOnce(replay);
    await expect(activities.persistOfferings({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{
        url: 'https://acme.example/products',
        offerings: [{ name: 'Pump', confidence: 0.8 }],
        durableReceipt: OFFERING_RECEIPT,
        crawlDurableReceipt: CRAWL_RECEIPT,
      }],
    })).resolves.toEqual({ offeringCount: 4 });
    expect(tx.offering.upsert).not.toHaveBeenCalled();

    acknowledgementMocks.plural.mockImplementationOnce(replay);
    await expect(activities.persistPublicContacts({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{
        url: 'https://acme.example/contact',
        text: 'Email info@acme.example',
        durableReceipt: CRAWL_RECEIPT,
      }],
    })).resolves.toEqual({ contactCount: 1 });
    expect(contactUpdate).not.toHaveBeenCalled();

    tx.companyProfile.findUniqueOrThrow.mockResolvedValueOnce({
      publicContacts: null,
    });
    acknowledgementMocks.plural.mockImplementationOnce(replay);
    await expect(activities.persistPublicContacts({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{
        url: 'https://acme.example/contact',
        text: 'No public contacts.',
        durableReceipt: CRAWL_RECEIPT,
      }],
    })).resolves.toEqual({ contactCount: 0 });
  });
});
