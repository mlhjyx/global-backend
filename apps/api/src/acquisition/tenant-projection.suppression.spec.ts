import { describe, expect, it, vi } from 'vitest';
import { TenantProjectionService } from './tenant-projection.service';

const source = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceKey: 'fair:example',
  providerKey: 'mapyourshow',
  config: { host: 'example.mapyourshow.com' },
};

function entity(index: number, email = 'sales@example.com') {
  const entityId = index.toString(16).padStart(12, '0');
  return {
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${entityId}`,
    sourceId: source.id,
    externalId: `source-entity-${index}`,
    name: `Example ${index}`,
    domain: `example-${index}.com`,
    country: 'DE',
    withdrawnAt: null,
    cleaned: { email_kind: 'role', email },
    contentHash: 'a'.repeat(64),
    lastSeenAt: new Date('2026-08-25T16:31:00.000Z'),
    lastSeenFetchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
  const suppressionRecord = {
    findMany: vi.fn(async () => suppressions.shift() ?? []),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
    suppressionRecord,
    canonicalCompany: {
      findUnique: vi.fn(async () =>
        prior
          ? {
              name: 'Existing Company',
              domain: null,
              status: 'NEW',
              ...prior,
            }
          : null,
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (prior) updates.push(data);
        return { count: prior ? 1 : 0 };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: `company-${creates.length}`, ...data };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { id: prior?.id ?? 'company-updated', ...data };
      }),
    },
    identityLink: {
      findFirst: vi.fn(async () => ({ id: 'existing-link' })),
      create: vi.fn(),
    },
    rawSourceRecord: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'raw-bridge',
        payloadHash: create.payloadHash,
        ingestStatus: create.ingestStatus,
      })),
    },
    fieldEvidence: { create: vi.fn() },
  };
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => source) },
    sourceEntity: { findMany: vi.fn(async () => entities) },
    sourceFetch: { findMany: vi.fn(async () => [{
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sourceId: source.id,
      status: 'DONE',
      parserVersion: 'acquisition/v1',
      finishedAt: new Date('2026-08-25T16:31:00.000Z'),
    }]) },
    sourcePolicy: { findMany: vi.fn(async () => [{
      id: 'policy-1',
      domain: 'mapyourshow.com',
      retentionDays: 365,
      reviewStatus: 'APPROVED',
      allowedPurpose: ['discovery'],
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    }]) },
    withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    service: new TenantProjectionService({ prisma: prisma as never }),
    creates,
    updates,
    suppressionRecord,
  };
}

describe('TenantProjectionService — suppression-aware role mailbox projection', () => {
  it('does not rematerialize an already suppressed exact role mailbox', async () => {
    const harness = projectionHarness([entity(1)], [[{ type: 'email', value: ' Sales@EXAMPLE.COM ' }]]);

    await harness.service.projectSource('11111111-1111-4111-8111-111111111111', source.id);

    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0].attributes).not.toHaveProperty('contact_email');
  });

  it('does not create a role mailbox whose own domain is suppressed', async () => {
    const harness = projectionHarness(
      [entity(1, 'buyer@agency.example')],
      [[{ type: 'domain', value: 'agency.example' }]],
    );

    await harness.service.projectSource('11111111-1111-4111-8111-111111111111', source.id);

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

    await harness.service.projectSource('11111111-1111-4111-8111-111111111111', source.id);

    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].attributes).not.toHaveProperty('contact_email');
    expect(harness.updates[0].attributes).toHaveProperty('products', ['pump']);
  });

  it('refreshes suppression facts for each chunk so a later fact blocks later projection', async () => {
    const entities = Array.from({ length: 101 }, (_, index) =>
      entity(index + 1, index === 100 ? 'blocked@example.com' : undefined),
    );
    const harness = projectionHarness(entities, [[], [{ type: 'email', value: 'blocked@example.com' }]]);

    await harness.service.projectSource('11111111-1111-4111-8111-111111111111', source.id);

    expect(harness.suppressionRecord.findMany).toHaveBeenCalledTimes(2);
    expect(harness.creates).toHaveLength(101);
    expect(harness.creates.at(-1)?.attributes).not.toHaveProperty('contact_email');
  });

  it('repairs and stops when an existing canonical identity matches company suppression', async () => {
    const incoming = { ...entity(1), name: 'Source Listing GmbH', domain: null };
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

    const result = await harness.service.projectSource(
      '11111111-1111-4111-8111-111111111111',
      source.id,
    );

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
