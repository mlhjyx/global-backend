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

function projectionHarness(entities: ReturnType<typeof entity>[], suppressions: unknown[][]) {
  const creates: Record<string, unknown>[] = [];
  const suppressionRecord = {
    findMany: vi.fn(async () => suppressions.shift() ?? []),
  };
  const tx = {
    suppressionRecord,
    canonicalCompany: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: `company-${creates.length}`, ...data };
      }),
      update: vi.fn(),
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
