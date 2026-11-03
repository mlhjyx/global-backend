import { describe, expect, it, vi } from 'vitest';
import { ChannelService } from './channel.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const CTX = { workspaceId: WORKSPACE_ID, userId: USER_ID, roles: [] } as never;

const CRAWL_CONFIG = {
  list: { url: 'https://expo.example/exhibitors?page={page}', maxPages: 5, itemSelector: '.card' },
  detail: { enabled: true, fields: { name: 'h1' } },
};

function makeService(state: {
  channel?: Record<string, unknown> | null;
  suppression?: Array<{ type: string; value: string }>;
  canonical?: (dedupeKey: string) => { id: string } | null;
  existingStreak?: number;
  existingStatus?: string;
} = {}) {
  const writes = {
    channels: [] as Array<{ op: string; data: Record<string, unknown> }>,
    runs: [] as Array<Record<string, unknown>>,
    importedBuyers: [] as Array<Record<string, unknown>>,
    companies: [] as Array<Record<string, unknown>>,
    sightings: [] as Array<Record<string, unknown>>,
    enablements: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    sourceChannel: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.channels.push({ op: 'create', data });
        return { id: CHANNEL_ID, failureStreak: 0, lastRunAt: null, createdAt: new Date(), updatedAt: new Date(), license: null, tosUrl: null, robotsPolicy: null, owner: null, ...data };
      }),
      findUnique: vi.fn(async () =>
        state.channel === undefined
          ? { id: CHANNEL_ID, mode: 'crawl', status: 'ENABLED', failureStreak: state.existingStreak ?? 0, config: CRAWL_CONFIG }
          : state.channel,
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.channels.push({ op: 'update', data });
        return { id: CHANNEL_ID, name: 'c', mode: 'crawl', category: 'trade_fair', status: 'DISABLED', config: CRAWL_CONFIG, failureStreak: 0, lastRunAt: null, license: null, tosUrl: null, robotsPolicy: null, owner: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      }),
      findMany: vi.fn(async () => []),
    },
    sourceChannelEnablement: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        writes.enablements.push(args);
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
    sourceChannelRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.runs.push(data);
        return { id: 'run-1', ...data };
      }),
    },
    suppressionRecord: { findMany: vi.fn(async () => state.suppression ?? []) },
    canonicalCompany: {
      findMany: vi.fn(async ({ where }: { where?: { dedupeKey?: { in?: string[] } } }) => {
        const keys = where?.dedupeKey?.in ?? [];
        return keys.filter((key) => state.canonical?.(key)).map((key) => ({ dedupeKey: key }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_dedupeKey: { dedupeKey: string } } }) =>
        state.canonical?.(where.workspaceId_dedupeKey.dedupeKey) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.companies.push(data);
        return { id: `company-${writes.companies.length}` };
      }),
    },
    companyChannelSighting: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.sightings.push(data);
        return {};
      }),
    },
    importedBuyer: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.importedBuyers.push(data);
        return data;
      }),
      findMany: vi.fn(async () => []),
    },
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  return { service: new ChannelService(prisma as never), writes, tx };
}

const SAMPLE = 'company,website,country\nAcme,https://acme.de,DE\nAcme Duplicate,https://acme.de,DE\nBlocked GmbH,https://blocked.de,DE';

describe('M1 渠道服务：治理闸门', () => {
  it('creates channels DISABLED with a validated config', async () => {
    const { service, writes } = makeService();
    await service.createChannel(CTX, { name: 'Hannover Messe', mode: 'crawl', category: 'trade_fair', config: CRAWL_CONFIG });
    expect(writes.channels[0]).toMatchObject({
      op: 'create',
      data: expect.objectContaining({ name: 'Hannover Messe', mode: 'crawl', status: 'DISABLED' }),
    });
  });

  it('rejects an invalid crawl config before any write', async () => {
    const { service, writes } = makeService();
    await expect(
      service.createChannel(CTX, { name: 'x', mode: 'crawl', category: 'trade_fair', config: { list: {} } }),
    ).rejects.toMatchObject({ status: 400, response: { error: { code: 'CHANNEL_CONFIG_INVALID' } } });
    expect(writes.channels).toHaveLength(0);
  });

  it('refuses to enable without the governance fields, and crawl channels need robots A', async () => {
    const { service } = makeService({ channel: { id: CHANNEL_ID, mode: 'crawl', status: 'DISABLED', config: CRAWL_CONFIG, license: null, tosUrl: null, robotsPolicy: null, name: 'c', category: 'trade_fair', owner: null, failureStreak: 0, lastRunAt: null, createdAt: new Date(), updatedAt: new Date() } });
    await expect(service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_GOVERNANCE_INCOMPLETE' } },
    });
    await expect(
      service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED', license: 'L', tosUrl: 'https://x.example/tos', robotsPolicy: 'B' }),
    ).rejects.toMatchObject({ status: 409, response: { error: { code: 'CHANNEL_ROBOTS_NOT_ALLOWED' } } });
  });

  it('enables a channel only when it is an approved ENABLED channel', async () => {
    const approved = makeService({ channel: { id: CHANNEL_ID, status: 'ENABLED' } });
    await expect(approved.service.enableChannel(CTX, CHANNEL_ID)).resolves.toEqual({ channelId: CHANNEL_ID, enabled: true });
    expect(approved.writes.enablements).toHaveLength(1);

    const pending = makeService({ channel: { id: CHANNEL_ID, status: 'DISABLED' } });
    await expect(pending.service.enableChannel(CTX, CHANNEL_ID)).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_NOT_APPROVED' } },
    });
  });

  it('fail-closes crawl execution until the platform crawl authority exists', async () => {
    const { service } = makeService({ channel: { id: CHANNEL_ID, mode: 'crawl', status: 'ENABLED' } });
    await expect(service.requestCrawl(CTX, CHANNEL_ID, 'preview')).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY' } },
    });
  });
});

describe('M1 导入通道：端到端物化', () => {
  const mapping = { name: 'company', website: 'website', country: 'country' };

  it('materializes new rows, counts in-batch duplicates and suppression hits without writing them', async () => {
    const { service, writes } = makeService({
      suppression: [{ type: 'company_name', value: 'blocked gmbh' }],
    });
    const result = await service.importBuyers(CTX, { csv: SAMPLE, mapping });
    expect(result).toMatchObject({ materialized: 1, duplicates: 1, suppressed: 1, totalRows: 3 });
    expect(writes.companies).toHaveLength(1);
    expect(writes.companies[0]).toMatchObject({ workspaceId: WORKSPACE_ID, domain: 'acme.de', dedupeKey: 'd:acme.de' });
    expect(writes.sightings).toHaveLength(1);
    expect(writes.importedBuyers.map((row) => row.status)).toEqual(['MATERIALIZED', 'DUPLICATE', 'SUPPRESSED']);
  });

  it('counts rows already in the pool as duplicates and links the existing company', async () => {
    const { service, writes } = makeService({
      canonical: (dedupeKey) => (dedupeKey === 'd:acme.de' ? { id: 'existing-1' } : null),
    });
    const result = await service.importBuyers(CTX, { csv: SAMPLE, mapping });
    expect(result).toMatchObject({ materialized: 1, duplicates: 2 });
    expect(writes.companies).toHaveLength(1); // Blocked GmbH still materializes (no suppression configured)
    const duplicate = writes.importedBuyers.find((row) => row.status === 'DUPLICATE');
    expect(duplicate).toMatchObject({ canonicalCompanyId: 'existing-1' });
  });

  it('previews duplicates/suppression without writing anything', async () => {
    const { service, writes } = makeService({
      suppression: [{ type: 'company_name', value: 'blocked gmbh' }],
      canonical: (dedupeKey) => (dedupeKey === 'd:acme.de' ? { id: 'existing-1' } : null),
    });
    const preview = await service.previewImport(CTX, { csv: SAMPLE, mapping });
    expect(preview).toMatchObject({
      totalRows: 3,
      validRows: 3,
      preview: { duplicate: 2, suppressed: 1 },
    });
    expect(writes.companies).toHaveLength(0);
    expect(writes.importedBuyers).toHaveLength(0);
  });
});

describe('M1 渠道运行统计与自动停用', () => {
  it('increments the failure streak on a bad round and auto-disables on the third', async () => {
    const { service, writes } = makeService({ existingStreak: 2, existingStatus: 'ENABLED' });
    const result = await service.recordChannelRun({
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      status: 'SUCCEEDED',
      pagesFetched: 10,
      recordsFound: 20,
      recordsMaterialized: 20,
      failures: 5, // 50% > 30%
    });
    expect(result).toMatchObject({ autoDisabled: true, failureStreak: 3 });
    expect(writes.channels.at(-1)).toMatchObject({ op: 'update', data: { status: 'AUTO_DISABLED', failureStreak: 3 } });
  });

  it('resets the streak on a healthy round', async () => {
    const { service, writes } = makeService({ existingStreak: 2, existingStatus: 'ENABLED' });
    const result = await service.recordChannelRun({
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      status: 'SUCCEEDED',
      pagesFetched: 10,
      recordsFound: 20,
      recordsMaterialized: 18,
      failures: 1,
    });
    expect(result).toMatchObject({ autoDisabled: false, failureStreak: 0 });
    expect(writes.channels.at(-1)).toMatchObject({ op: 'update', data: { failureStreak: 0 } });
  });
});
