import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import type { EmailVerifyContext, ExecutionContext } from './provider-contract';

const mocks = vi.hoisted(() => ({
  persistDiscoveredContacts: vi.fn(),
  persistGuessedEmail: vi.fn(),
  applyDomainAckConsumerTransactions: vi.fn(),
}));

vi.mock('./contact-persist', () => ({
  persistDiscoveredContacts: mocks.persistDiscoveredContacts,
}));
vi.mock('./email-guess-persist', () => ({
  persistGuessedEmail: mocks.persistGuessedEmail,
}));
vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: mocks.applyDomainAckConsumerTransactions,
}));

import { DiscoveryService } from './discovery.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const POINT_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORITY_ID = '55555555-5555-4555-8555-555555555555';
const CTX: RequestContext = {
  workspaceId: WORKSPACE_ID,
  userId: 'receipt-consumer-test',
  roles: [],
};

function receipt(
  operationId: string,
  resultSchema: string,
  digestCharacter: string,
): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: WORKSPACE_ID,
    authorityId: AUTHORITY_ID,
    accountId: '66666666-6666-4666-8666-666666666666',
    operationId,
    operationKey: `receipt-consumer:${operationId}`,
    resultStrategy: 'typed_projection',
    resultSchema,
    resultDigest: digestCharacter.repeat(64),
    artifactId: null,
    usage: {
      currency: 'USD', unit: 'microusd', callCount: 1,
      upperBoundMicrousd: '10000',
    },
    costBasis: 'estimated_upper_bound',
  });
}

const TOOL_RECEIPT = receipt(
  '77777777-7777-4777-8777-777777777777',
  'crawl4ai-fetch/v1',
  'a',
);
const MODEL_RECEIPT = receipt(
  '88888888-8888-4888-8888-888888888888',
  'contact-decision-makers/v1',
  'b',
);
const SMTP_RECEIPT = receipt(
  '99999999-9999-4999-8999-999999999999',
  'smtp-rcpt-probe/v1',
  'c',
);

function authority(accountKey: string) {
  return {
    consumeWorkspaceGrant: vi.fn(async () => ({
      authorityId: AUTHORITY_ID,
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey,
      purpose: 'test',
      subjectType: 'test',
      subjectId: COMPANY_ID,
      requestSha256: 'd'.repeat(64),
    })),
  };
}

function budgetStore() {
  return {
    attestAuthorized: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ exhausted: false, open: true })),
  };
}

describe('actual discovery receipt consumers', () => {
  beforeEach(() => {
    mocks.persistDiscoveredContacts.mockReset();
    mocks.persistDiscoveredContacts.mockResolvedValue({
      created: 1,
      merged: 0,
      skippedSuppressed: 0,
      skippedInvalid: 0,
    });
    mocks.persistGuessedEmail.mockReset();
    mocks.persistGuessedEmail.mockResolvedValue({
      persisted: true,
      email: 'hans.herold@acme.example',
      status: 'VALID',
    });
    mocks.applyDomainAckConsumerTransactions.mockReset();
    mocks.applyDomainAckConsumerTransactions.mockImplementation(async (input: {
      transaction: unknown;
      apply: (transaction: unknown) => Promise<unknown>;
      acknowledgements: Array<{ producerId: string }>;
    }) => ({
      status: 'APPLIED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId,
        status: 'APPLIED',
      })),
      value: await input.apply(input.transaction),
    }));
  });

  it('captures contact Tool and Model receipts and ACKs the exact contact persistence transaction', async () => {
    const company = {
      id: COMPANY_ID,
      name: 'Acme GmbH',
      domain: 'acme.example',
      country: 'DE',
      status: 'NEW',
      dedupeKey: 'd:acme.example',
    };
    const adapter = {
      key: 'decision_maker',
      discoverContacts: vi.fn(async (
        _company: unknown,
        executionContext: ExecutionContext,
      ) => {
        executionContext.onDurableReceipt?.('crawl4ai.fetch', TOOL_RECEIPT);
        executionContext.onDurableReceipt?.(
          'contact.find_decision_makers',
          MODEL_RECEIPT,
        );
        return {
          contacts: [{
            externalId: 'public-source-1',
            fullName: 'Named Person',
            personalData: true,
            sourcePage: 'https://acme.example/impressum',
          }],
          costCents: 2,
        };
      }),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      canonicalContact: {
        findMany: vi.fn(async () => []),
      },
      usageLedger: { create: vi.fn(async () => ({})) },
      fieldEvidence: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const service = new DiscoveryService(
      prisma as never,
      { routeContactDiscovery: vi.fn(async () => [adapter]) } as never,
      authority('contact-discovery-account') as never,
      budgetStore() as never,
    );

    await service.discoverContacts(CTX, COMPANY_ID);

    expect(mocks.applyDomainAckConsumerTransactions).toHaveBeenCalledOnce();
    const acknowledgementInput = mocks.applyDomainAckConsumerTransactions.mock.calls[0]?.[0];
    expect(acknowledgementInput).toMatchObject({
      transaction: tx,
      acknowledgements: [
        { producerId: 'crawl4ai.fetch', receipt: TOOL_RECEIPT },
        { producerId: 'contact.find_decision_makers', receipt: MODEL_RECEIPT },
      ],
    });
    expect(mocks.persistDiscoveredContacts).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ adapterKey: 'decision_maker' }),
    );
    expect(tx.usageLedger.create).toHaveBeenCalledOnce();

    mocks.applyDomainAckConsumerTransactions.mockImplementationOnce(
      async (input: {
        transaction: unknown;
        readback: (transaction: unknown) => Promise<unknown>;
        acknowledgements: Array<{ producerId: string }>;
      }) => ({
        status: 'REPLAYED',
        acknowledgements: input.acknowledgements.map(({ producerId }) => ({
          producerId,
          status: 'REPLAYED',
        })),
        value: await input.readback(input.transaction),
      }),
    );
    await expect(service.discoverContacts(CTX, COMPANY_ID)).resolves.toEqual({
      contacts: [],
      skippedSuppressed: 0,
      skippedInvalid: 0,
    });
    expect(mocks.persistDiscoveredContacts).toHaveBeenCalledOnce();

    adapter.discoverContacts.mockImplementationOnce(async (
      _company: unknown,
      executionContext: ExecutionContext,
    ) => {
      executionContext.onDurableReceipt?.('unexpected.tool', TOOL_RECEIPT);
      return { contacts: [], costCents: 0 };
    });
    await expect(service.discoverContacts(CTX, COMPANY_ID)).rejects.toThrow(
      'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
    );
  });

  it('captures smtp.rcpt_probe and ACKs the exact ContactPoint verdict writes transaction', async () => {
    const company = {
      id: COMPANY_ID,
      name: 'Acme GmbH',
      domain: 'acme.example',
      status: 'ENRICHED',
      dedupeKey: 'd:acme.example',
      attributes: {},
    };
    const point = {
      id: POINT_ID,
      workspaceId: WORKSPACE_ID,
      contactId: CONTACT_ID,
      type: 'email',
      value: 'info@acme.example',
      status: 'UNVERIFIED',
      verifiedAt: null,
      contact: { company },
    };
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...point,
      ...data,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      contactPoint: {
        findUnique: vi.fn(async () => point),
        update,
      },
      canonicalContact: {
        findUnique: vi.fn(async () => ({
          id: CONTACT_ID,
          fullName: 'Info Desk',
          company,
        })),
      },
      canonicalCompany: {
        update: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const verifyEmail = vi.fn(async (
      _email: string,
      verifyContext?: EmailVerifyContext,
    ) => {
      const receiptContext = verifyContext as EmailVerifyContext & {
        onDurableReceipt?: (
          producerId: string,
          durableReceipt: DurableExecutionReceipt,
        ) => void;
      };
      receiptContext.onDurableReceipt?.('smtp.rcpt_probe', SMTP_RECEIPT);
      return { status: 'VALID' as const, detail: 'smtp_accepted:250', costCents: 0 };
    });
    const service = new DiscoveryService(
      prisma as never,
      {
        routeEmailVerification: vi.fn(async () => [{
          key: 'smtp_self',
          verifyEmail,
        }]),
      } as never,
      authority('email-verification-account') as never,
      budgetStore() as never,
    );

    await service.verifyContactPoint(CTX, POINT_ID);

    expect(mocks.applyDomainAckConsumerTransactions).toHaveBeenCalledOnce();
    expect(mocks.applyDomainAckConsumerTransactions.mock.calls[0]?.[0]).toMatchObject({
      transaction: tx,
      acknowledgements: [{
        producerId: 'smtp.rcpt_probe',
        receipt: SMTP_RECEIPT,
      }],
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'VALID' }),
    }));

    mocks.applyDomainAckConsumerTransactions.mockImplementationOnce(
      async (input: {
        transaction: unknown;
        readback: (transaction: unknown) => Promise<unknown>;
        acknowledgements: Array<{ producerId: string }>;
      }) => ({
        status: 'REPLAYED',
        acknowledgements: input.acknowledgements.map(({ producerId }) => ({
          producerId,
          status: 'REPLAYED',
        })),
        value: await input.readback(input.transaction),
      }),
    );
    await expect(service.verifyContactPoint(CTX, POINT_ID)).resolves.toMatchObject({
      verification: { status: 'VALID' },
    });
    expect(update).toHaveBeenCalledOnce();

    verifyEmail.mockImplementationOnce(async (
      _email: string,
      verifyContext?: EmailVerifyContext,
    ) => {
      verifyContext?.onDurableReceipt?.('unexpected.tool', SMTP_RECEIPT);
      return { status: 'VALID' as const, costCents: 0 };
    });
    await expect(service.verifyContactPoint(CTX, POINT_ID)).rejects.toThrow(
      'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
    );
  });

  it('carries every guessed-email SMTP receipt into the exact guessed ContactPoint transaction', async () => {
    const company = {
      id: COMPANY_ID,
      name: 'Acme GmbH',
      domain: 'acme.example',
      status: 'ENRICHED',
      dedupeKey: 'd:acme.example',
      attributes: {},
    };
    const contact = {
      id: CONTACT_ID,
      contactId: CONTACT_ID,
      companyId: COMPANY_ID,
      fullName: 'Hans Herold',
      title: 'Managing Director',
      contactPoints: [],
      company,
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      canonicalContact: {
        findMany: vi.fn(async () => [contact]),
        findUnique: vi.fn(async () => contact),
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (
        _workspaceId: string,
        callback: (transaction: typeof tx) => Promise<unknown>,
      ) => callback(tx)),
    };
    const verifyEmail = vi.fn(async (
      _email: string,
      verifyContext?: EmailVerifyContext,
    ) => {
      verifyContext?.onDurableReceipt?.('smtp.rcpt_probe', SMTP_RECEIPT);
      return {
        status: 'VALID' as const,
        detail: 'smtp_accepted:250',
        costCents: 0,
      };
    });
    const service = new DiscoveryService(
      prisma as never,
      {
        routeEmailVerification: vi.fn(async () => [{
          key: 'smtp_self',
          verifyEmail,
        }]),
      } as never,
      authority('email-guess-account') as never,
      budgetStore() as never,
    );

    await expect(service.guessEmailsForCompany(CTX, COMPANY_ID, {
      lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-test' },
      maxContacts: 1,
      maxProbe: 1,
    })).resolves.toMatchObject({ persisted: 1, verified: 1 });

    const acknowledgement = mocks.applyDomainAckConsumerTransactions.mock.calls
      .find((call) => call[0]?.acknowledgements?.[0]?.producerId === 'smtp.rcpt_probe')?.[0];
    expect(acknowledgement).toMatchObject({
      transaction: tx,
      acknowledgements: [{
        producerId: 'smtp.rcpt_probe',
        receipt: SMTP_RECEIPT,
      }],
    });
    expect(mocks.persistGuessedEmail).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ contactId: CONTACT_ID }),
    );
  });
});
