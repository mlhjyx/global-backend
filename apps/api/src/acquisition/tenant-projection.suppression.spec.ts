import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveOrganizationIdentityForRaw = vi.hoisted(() => vi.fn());

vi.mock('../discovery/organization-identity-resolver', async (importOriginal) => {
  const original = await importOriginal<typeof import('../discovery/organization-identity-resolver')>();
  return { ...original, resolveOrganizationIdentityForRaw };
});

import { TenantProjectionService } from './tenant-projection.service';

const source = {
  id: 'source-1',
  sourceKey: 'fair:example',
  providerKey: 'trade_fair',
  status: 'ACTIVE',
  config: {
    sourceUrl: 'https://algolia.net/example',
  },
};

function entity(index: number, email = 'sales@example.com') {
  return {
    id: `entity-${index}`,
    sourceId: source.id,
    externalId: `external-${index}`,
    name: `Example ${index}`,
    domain: `example-${index}.com`,
    country: 'DE',
    withdrawnAt: null,
    cleaned: { email_kind: 'role', email },
    contentHash: index.toString(16).padStart(64, '0'),
    lastSeenAt: new Date('2026-08-12T16:31:00.000Z'),
    lastSeenFetchId: 'fetch-1',
  };
}

function projectionHarness(
  entities: ReturnType<typeof entity>[],
  suppressions: unknown[][],
  prior?: {
    id: string;
    name?: string;
    domain?: string | null;
    status?: string;
    attributes: Record<string, unknown>;
  },
) {
  const creates: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const rawCreates: Record<string, unknown>[] = [];
  const companies = new Map<string, Record<string, unknown>>();
  if (prior) companies.set(prior.id, { name: 'Existing Company', domain: null, status: 'NEW', ...prior });
  const suppressionRecord = {
    findMany: vi.fn(async () => suppressions.shift() ?? []),
  };
  const tx = {
    __priorCompanyId: prior?.id ?? null,
    $queryRaw: vi.fn(async () => [{ locked: '' }]),
    suppressionRecord,
    canonicalCompany: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (where.id) return companies.get(where.id) ?? null;
        return prior ? companies.get(prior.id) ?? null : null;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (prior) updates.push(data);
        return { count: prior ? 1 : 0 };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        const created = { id: `company-${creates.length}`, ...data };
        companies.set(created.id, created);
        return created;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        const id = prior?.id ?? 'company-1';
        const updated = { ...(companies.get(id) ?? {}), id, ...data };
        companies.set(id, updated);
        return updated;
      }),
    },
    rawSourceRecord: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...(rawCreates.push(create), {}),
        id: `raw-${String(create.sourceEntityId)}`,
        payloadHash: create.payloadHash,
        ingestStatus: 'ACCEPTED',
      })),
    },
    fieldEvidence: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => source) },
    sourceEntity: { findMany: vi.fn(async () => entities) },
    sourceFetch: {
      findMany: vi.fn(async () => [{
        id: 'fetch-1',
        status: 'DONE',
        parserVersion: 'acquisition/v1',
        finishedAt: new Date('2026-08-12T16:31:00.000Z'),
      }]),
    },
    sourcePolicy: {
      findMany: vi.fn(async () => [
        {
          id: 'policy-1',
          domain: 'algolia.net',
          retentionDays: 365,
          reviewStatus: 'APPROVED',
          allowedPurpose: ['discovery', 'enrichment'],
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]),
    },
    withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    service: new TenantProjectionService({ prisma: prisma as never }),
    creates,
    updates,
    rawCreates,
    suppressionRecord,
  };
}

beforeEach(() => {
  resolveOrganizationIdentityForRaw.mockReset();
  resolveOrganizationIdentityForRaw.mockImplementation(async (tx: any, input: any) => {
    const existing = priorCompanyId(tx);
    if (existing) return { kind: 'bound', companyId: existing, replayed: false };
    const created = await tx.canonicalCompany.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.record.name,
        domain: input.record.domain ?? null,
        country: input.record.country ?? null,
        attributes: input.record.attributes ?? {},
        status: 'NEW',
        dedupeKey: `mock:${input.record.name}`,
      },
    });
    return { kind: 'bound', companyId: created.id, replayed: false };
  });
});

function priorCompanyId(tx: any): string | null {
  return tx.__priorCompanyId ?? null;
}

describe('TenantProjectionService — suppression-aware role mailbox projection', () => {
  it('does not rematerialize an already suppressed exact role mailbox', async () => {
    const harness = projectionHarness([entity(1)], [[{ type: 'email', value: ' Sales@EXAMPLE.COM ' }]]);

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0].attributes).not.toHaveProperty('contact_email');
    expect(harness.rawCreates[0].payload).not.toHaveProperty('attributes.contact_email');
  });

  it('keeps the Raw receipt independent of later suppression changes while changing only canonical email materialization', async () => {
    const harness = projectionHarness(
      [entity(1)],
      [[], [{ type: 'email', value: 'sales@example.com' }]],
      { id: 'company-existing', attributes: {} },
    );

    await harness.service.projectSource('workspace-1', source.id);
    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.rawCreates).toHaveLength(2);
    expect(harness.rawCreates[0].payloadHash).toBe(harness.rawCreates[1].payloadHash);
    expect(harness.rawCreates[0].payload).toEqual(harness.rawCreates[1].payload);
    expect(harness.updates[0].attributes).toHaveProperty('contact_email', 'sales@example.com');
    expect(harness.updates[1].attributes).not.toHaveProperty('contact_email');
  });

  it('does not create a role mailbox whose own domain is suppressed', async () => {
    const harness = projectionHarness(
      [entity(1, 'buyer@agency.example')],
      [[{ type: 'domain', value: 'agency.example' }]],
    );

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0].attributes).not.toHaveProperty('contact_email');
  });

  it('removes a prior role mailbox when its own domain becomes suppressed', async () => {
    const harness = projectionHarness(
      [entity(1, 'buyer@agency.example')],
      [[{ type: 'domain', value: 'agency.example' }]],
      {
        id: 'company-existing',
        attributes: {
          contact_email: 'buyer@agency.example',
          products: ['pump'],
        },
      },
    );

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].attributes).not.toHaveProperty('contact_email');
    expect(harness.updates[0].attributes).toHaveProperty('products', ['pump']);
  });

  it('refreshes suppression facts for each chunk so a later fact blocks later projection', async () => {
    const entities = Array.from({ length: 101 }, (_, index) =>
      entity(index + 1, index === 100 ? 'blocked@example.com' : undefined),
    );
    const harness = projectionHarness(entities, [[], [{ type: 'email', value: 'blocked@example.com' }]]);

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.suppressionRecord.findMany).toHaveBeenCalledTimes(2);
    expect(harness.creates).toHaveLength(101);
    expect(harness.creates.at(-1)?.attributes).not.toHaveProperty('contact_email');
  });

  it('repairs and stops when an existing canonical identity matches company suppression', async () => {
    const incoming = { ...entity(1), name: 'Source Listing Name', domain: null };
    const harness = projectionHarness(
      [incoming],
      [[{ type: 'domain', value: 'blocked.example' }]],
      {
        id: 'company-existing',
        name: 'Existing Legal Entity GmbH',
        domain: 'https://www.blocked.example/about',
        status: 'NEW',
        attributes: { products: ['pump'], contact_email: 'sales@blocked.example' },
      },
    );

    const result = await harness.service.projectSource('workspace-1', source.id);

    expect(result).toMatchObject({ projected: 0, suppressed: 1 });
    expect(harness.updates).toEqual([
      {
        status: 'SUPPRESSED',
        attributes: { products: ['pump'] },
        version: { increment: 1 },
      },
    ]);
  });
});
