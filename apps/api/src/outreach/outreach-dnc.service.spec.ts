import { describe, expect, it } from 'vitest';
import { OutreachDncService } from './outreach-dnc.service';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';

interface SuppressionRow {
  emailHash: string;
  reason: string;
  source: string;
}

class FakePrisma {
  readonly globalRows: SuppressionRow[] = [];
  constructor(
    private readonly tenantRows: Array<{ value: string; reason: string | null }> = [],
  ) {}

  async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: {
      suppressionRecord: {
        findMany: () => Promise<Array<{ value: string; reason: string | null }>>;
      };
    }) => Promise<T>,
  ): Promise<T> {
    expect(workspaceId).toBe(WORKSPACE);
    return fn({
      suppressionRecord: { findMany: async () => this.tenantRows },
    });
  }

  readonly outreachGlobalSuppression = {
    findMany: async () => this.globalRows,
    createMany: async ({
      data,
    }: {
      data: SuppressionRow[];
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        if (this.globalRows.some((existing) => existing.emailHash === row.emailHash)) {
          continue;
        }
        this.globalRows.push(row);
        count += 1;
      }
      return { count };
    },
  };
}

describe('OutreachDncService', () => {
  it('canonicalizes addresses and hashes them without returning plaintext', async () => {
    const service = new OutreachDncService(new FakePrisma() as never);
    const [result] = await service.check(WORKSPACE, [' Alice@Example.COM ']);
    expect(result.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.suppressed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('alice@example.com');
    expect(service.canonicalEmail(' Alice@Example.COM ')).toBe('alice@example.com');
    expect(service.emailHash('alice@example.com')).toBe(result.emailHash);
  });

  it('suppresses on the tenant list and reports the reason', async () => {
    const service = new OutreachDncService(
      new FakePrisma([{ value: 'alice@example.com', reason: 'unsubscribe' }]) as never,
    );
    const [result] = await service.check(WORKSPACE, ['alice@example.com']);
    expect(result.suppressed).toBe(true);
    expect(result.reasons).toEqual(['tenant:unsubscribe']);
  });

  it('suppresses on the platform-wide hash list across tenants', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never);
    await service.suppressGlobal({
      email: 'bob@example.com',
      reason: 'complaint',
      source: 'outreach_unsubscribe',
    });
    const [result] = await service.check(WORKSPACE, ['BOB@example.com']);
    expect(result.suppressed).toBe(true);
    expect(result.reasons).toEqual(['global:complaint']);
    expect(prisma.globalRows).toHaveLength(1);
    expect(JSON.stringify(prisma.globalRows)).not.toContain('bob@example.com');
  });

  it('is idempotent for duplicate global suppressions', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never);
    await service.suppressGlobal({
      email: 'bob@example.com',
      reason: 'bounce',
      source: 'ops',
    });
    await service.suppressGlobal({
      email: 'bob@example.com',
      reason: 'complaint',
      source: 'ops',
    });
    expect(prisma.globalRows).toHaveLength(1);
  });

  it('deduplicates repeated addresses in one check', async () => {
    const service = new OutreachDncService(new FakePrisma() as never);
    const results = await service.check(WORKSPACE, [
      'alice@example.com',
      'ALICE@example.com',
    ]);
    expect(results).toHaveLength(1);
  });

  it('rejects invalid addresses and oversized batches', async () => {
    const service = new OutreachDncService(new FakePrisma() as never);
    await expect(service.check(WORKSPACE, ['not-an-email'])).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_DNC_INVALID_EMAIL' } },
    });
    await expect(
      service.check(
        WORKSPACE,
        Array.from({ length: 51 }, (_, index) => `user${index}@example.com`),
      ),
    ).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_DNC_BATCH_TOO_LARGE' } },
    });
    await expect(
      service.suppressGlobal({
        email: 'bob@example.com',
        reason: 'bogus' as never,
        source: 'ops',
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_DNC_INVALID_REASON' } },
    });
  });
});
