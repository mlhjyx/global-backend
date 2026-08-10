import { describe, expect, it, vi } from 'vitest';
import { TenantProjectionService } from './tenant-projection.service';

const source = {
  id: 'source-1',
  sourceKey: 'fair:example',
  providerKey: 'trade_fair',
};

function entity(index: number, email = 'sales@example.com') {
  return {
    id: `entity-${index}`,
    sourceId: source.id,
    name: `Example ${index}`,
    domain: `example-${index}.com`,
    country: 'DE',
    withdrawnAt: null,
    cleaned: { email_kind: 'role', email },
  };
}

function projectionHarness(
  entities: ReturnType<typeof entity>[],
  suppressions: unknown[][],
  prior?: { id: string; attributes: Record<string, unknown> },
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
      findUnique: vi.fn(async () => prior ?? null),
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
    fieldEvidence: { create: vi.fn() },
  };
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => source) },
    sourceEntity: { findMany: vi.fn(async () => entities) },
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
    const harness = projectionHarness([entity(1)], [
      [{ type: 'email', value: ' Sales@EXAMPLE.COM ' }],
    ]);

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0].attributes).not.toHaveProperty('contact_email');
  });

  it('does not create a role mailbox whose own domain is suppressed', async () => {
    const harness = projectionHarness([entity(1, 'buyer@agency.example')], [
      [{ type: 'domain', value: 'agency.example' }],
    ]);

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
        attributes: { contact_email: 'buyer@agency.example', products: ['pump'] },
      },
    );

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].attributes).toEqual({ products: ['pump'] });
  });

  it('refreshes suppression facts for each chunk so a later fact blocks later projection', async () => {
    const entities = Array.from({ length: 101 }, (_, index) =>
      entity(index + 1, index === 100 ? 'blocked@example.com' : undefined),
    );
    const harness = projectionHarness(entities, [
      [],
      [{ type: 'email', value: 'blocked@example.com' }],
    ]);

    await harness.service.projectSource('workspace-1', source.id);

    expect(harness.suppressionRecord.findMany).toHaveBeenCalledTimes(2);
    expect(harness.creates).toHaveLength(101);
    expect(harness.creates.at(-1)?.attributes).not.toHaveProperty(
      'contact_email',
    );
  });
});
