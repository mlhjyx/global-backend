import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutreachDncService } from './outreach-dnc.service';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const PEPPER_1 = '1'.repeat(64);
const PEPPER_2 = '2'.repeat(64);

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

  readonly $queryRaw = async () => [
    {
      currentUser: 'execution_budget_platform_writer_login',
      sessionUser: 'execution_budget_platform_writer_login',
      sessionRole: 'none',
      rolCanLogin: true,
      rolInherit: true,
      rolSuper: false,
      rolBypassRls: false,
      rolCreateDb: false,
      rolCreateRole: false,
      rolReplication: false,
      memberships: ['execution_budget_platform_writer'],
    },
  ];

  readonly outreachGlobalSuppression = {
    findMany: async ({
      where,
    }: {
      where?: { emailHash?: { in?: string[] } };
    } = {}) => {
      const target = where?.emailHash?.in;
      if (!target) return this.globalRows;
      return this.globalRows.filter((row) => target.includes(row.emailHash));
    },
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
  let prevPepper: string | undefined;
  let prevRetired: string | undefined;

  beforeEach(() => {
    prevPepper = process.env.OUTREACH_DNC_HMAC_PEPPER;
    prevRetired = process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS;
    process.env.OUTREACH_DNC_HMAC_PEPPER = PEPPER_1;
    delete process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS;
  });

  afterEach(() => {
    if (prevPepper === undefined) delete process.env.OUTREACH_DNC_HMAC_PEPPER;
    else process.env.OUTREACH_DNC_HMAC_PEPPER = prevPepper;
    if (prevRetired === undefined) delete process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS;
    else process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS = prevRetired;
  });

  it('canonicalizes addresses and preserves transient HTTP sha256 emailHash correlation key', async () => {
    const service = new OutreachDncService(new FakePrisma() as never);
    const [result] = await service.check(WORKSPACE, [' Alice@Example.COM ']);
    const expectedSha256 = createHash('sha256').update('alice@example.com').digest('hex');
    expect(result.emailHash).toBe(expectedSha256);
    expect(result.suppressed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('alice@example.com');
    expect(service.canonicalEmail(' Alice@Example.COM ')).toBe('alice@example.com');
    expect(service.emailHash('alice@example.com')).toBe(expectedSha256);
    expect(service.storageEmailHash('alice@example.com')).not.toBe(expectedSha256);
    expect(service.storageEmailHash('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('suppresses on the tenant list and reports the reason', async () => {
    const service = new OutreachDncService(
      new FakePrisma([{ value: 'alice@example.com', reason: 'unsubscribe' }]) as never,
    );
    const [result] = await service.check(WORKSPACE, ['alice@example.com']);
    expect(result.suppressed).toBe(true);
    expect(result.reasons).toEqual(['tenant:unsubscribe']);
  });

  it('stores peppered HMAC (not unsalted SHA-256) and matches across tenants', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never, prisma as never);
    await service.suppressGlobal({
      email: 'bob@example.com',
      reason: 'complaint',
      source: 'outreach_unsubscribe',
    });
    const unsalted = createHash('sha256').update('bob@example.com').digest('hex');
    expect(prisma.globalRows).toHaveLength(1);
    expect(prisma.globalRows[0]!.emailHash).not.toBe(unsalted);
    expect(prisma.globalRows[0]!.emailHash).toBe(service.storageEmailHash('bob@example.com'));

    const [result] = await service.check(WORKSPACE, ['BOB@example.com']);
    expect(result.emailHash).toBe(unsalted);
    expect(result.suppressed).toBe(true);
    expect(result.reasons).toEqual(['global:complaint']);
    expect(JSON.stringify(prisma.globalRows)).not.toContain('bob@example.com');
  });

  it('supports pepper rotation via OUTREACH_DNC_HMAC_RETIRED_PEPPERS on check()', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never, prisma as never);
    await service.suppressGlobal({
      email: 'rotated@example.com',
      reason: 'unsubscribe',
      source: 'outreach_unsubscribe',
    });

    process.env.OUTREACH_DNC_HMAC_PEPPER = PEPPER_2;
    const [missedWithoutRetired] = await service.check(WORKSPACE, ['rotated@example.com']);
    expect(missedWithoutRetired.suppressed).toBe(false);

    process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS = PEPPER_1;
    const [hitWithRetired] = await service.check(WORKSPACE, ['rotated@example.com']);
    expect(hitWithRetired.suppressed).toBe(true);
    expect(hitWithRetired.reasons).toEqual(['global:unsubscribe']);
  });

  it('fails closed with OUTREACH_DNC_PEPPER_UNAVAILABLE when pepper is missing or invalid', async () => {
    delete process.env.OUTREACH_DNC_HMAC_PEPPER;
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never, prisma as never);
    await expect(service.check(WORKSPACE, ['alice@example.com'])).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'OUTREACH_DNC_PEPPER_UNAVAILABLE' } },
    });
    await expect(
      service.suppressGlobal({
        email: 'alice@example.com',
        reason: 'unsubscribe',
        source: 'ops',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'OUTREACH_DNC_PEPPER_UNAVAILABLE' } },
    });

    process.env.OUTREACH_DNC_HMAC_PEPPER = 'not-a-valid-pepper';
    await expect(service.check(WORKSPACE, ['alice@example.com'])).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'OUTREACH_DNC_PEPPER_UNAVAILABLE' } },
    });
  });

  it('fails closed when global suppression runs without platformWriter', async () => {
    const service = new OutreachDncService(new FakePrisma() as never);
    await expect(
      service.suppressGlobal({
        email: 'bob@example.com',
        reason: 'complaint',
        source: 'outreach_unsubscribe',
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_DNC_WRITER_UNAVAILABLE' } },
    });
  });

  it('fails closed when global suppression receives a superuser or wrong-role platformWriter', async () => {
    const prisma = new FakePrisma();
    const badWriter = {
      $queryRaw: async () => [
        {
          currentUser: 'global',
          sessionUser: 'global',
          sessionRole: 'none',
          rolCanLogin: true,
          rolInherit: true,
          rolSuper: true,
          rolBypassRls: true,
          rolCreateDb: true,
          rolCreateRole: true,
          rolReplication: true,
          memberships: [],
        },
      ],
      outreachGlobalSuppression: prisma.outreachGlobalSuppression,
    };
    const service = new OutreachDncService(prisma as never, badWriter as never);
    await expect(
      service.suppressGlobal({
        email: 'bob@example.com',
        reason: 'complaint',
        source: 'outreach_unsubscribe',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'OUTREACH_DNC_WRITER_UNAVAILABLE' } },
    });
    expect(prisma.globalRows).toHaveLength(0);
  });

  it('is idempotent for duplicate global suppressions', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachDncService(prisma as never, prisma as never);
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
