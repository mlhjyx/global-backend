import { describe, expect, it, vi } from 'vitest';
import { ChannelProbeService, sanitizeProbeSample } from './channel-probe.service';
import type { ChannelHttpClient, ChannelHttpResponse } from './connector/http-transport';
import { parseChannelManifest } from './connector/channel-manifest';
import type { ChannelSecretResolver } from './connector/secret-resolver';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-09T00:00:00Z');
const CTX = { workspaceId: WORKSPACE_ID, userId: USER_ID, roles: [] } as never;

const MANIFEST = parseChannelManifest({
  meta: { name: 'SAM.gov', version: 1, category: 'tender' },
  transport: { baseUrl: 'https://api.sam.gov', responseType: 'json', allowedHosts: ['api.sam.gov'] },
  auth: { type: 'apiKey', secretRef: 'channel/samgov/api-key', in: 'query', name: 'api_key' },
  pagination: { type: 'none' },
  rateLimit: { rps: 50, burst: 2, perDomainDelayMs: 0 },
  records: { itemsPath: '$.opportunitiesData' },
  fieldMapping: { name: '$.title', country: '$.placeOfPerformance.country' },
});

const resolver: ChannelSecretResolver = {
  async resolve() {
    return { value: 'sam-secret', version: 1, provider: 'file' };
  },
};

function response(body: unknown, status = 200): ChannelHttpResponse {
  return { status, headers: {}, bodyText: JSON.stringify(body), finalUrl: 'https://api.sam.gov/opportunities', durationMs: 1 };
}

function makePrisma(channel: Record<string, unknown>) {
  const writes = {
    probes: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    sourceChannel: {
      findUnique: vi.fn(async () => channel),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.updates.push(data);
        return channel;
      }),
    },
    sourceChannelProbe: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.probes.push(data);
        return { id: 'probe-1', ...data };
      }),
    },
    sourceChannelHealthEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.events.push(data);
        return { id: `evt-${writes.events.length}`, ...data };
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma, tx, writes };
}

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    name: 'SAM.gov',
    mode: 'api',
    status: 'DISABLED',
    category: 'tender',
    config: { adapter: 'channel-manifest/v1' },
    manifest: MANIFEST,
    manifestSha256: 'a'.repeat(64),
    connectorKind: 'manifest',
    healthState: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    probeRequired: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    license: null,
    tosUrl: null,
    robotsPolicy: null,
    owner: null,
    failureStreak: 0,
    lastRunAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('保存即测试（probe）', () => {
  it('未接出网通道时 fail-closed：CHANNEL_TEST_EGRESS_UNAVAILABLE（503）', async () => {
    const { prisma } = makePrisma(channelRow());
    const service = new ChannelProbeService(prisma as never, resolver, undefined, () => NOW);
    await expect(service.probeChannel(CTX, CHANNEL_ID)).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'CHANNEL_TEST_EGRESS_UNAVAILABLE' } },
    });
  });

  it('非 api 渠道明确不支持（crawl 走平台抓取链，后续波次）', async () => {
    const { prisma } = makePrisma(channelRow({ mode: 'crawl', manifest: null }));
    const http: ChannelHttpClient = { request: vi.fn() };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    await expect(service.probeChannel(CTX, CHANNEL_ID)).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_TEST_UNSUPPORTED_MODE' } },
    });
  });

  it('api 渠道缺 manifest → CHANNEL_MANIFEST_REQUIRED', async () => {
    const { prisma } = makePrisma(channelRow({ manifest: null, manifestSha256: null }));
    const http: ChannelHttpClient = { request: vi.fn() };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    await expect(service.probeChannel(CTX, CHANNEL_ID)).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_MANIFEST_REQUIRED' } },
    });
  });

  it('成功：落 probe 行、解除 probe_required、写 PROBE_PASSED、样本脱敏', async () => {
    const { prisma, writes } = makePrisma(channelRow());
    const http: ChannelHttpClient = {
      request: vi.fn(async () =>
        response({
          opportunitiesData: [
            { title: 'Tender A', placeOfPerformance: { country: 'DEU' } },
            { title: 'Tender B', placeOfPerformance: { country: 'FRA' } },
          ],
        }),
      ),
    };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    const result = await service.probeChannel(CTX, CHANNEL_ID);
    expect(result).toMatchObject({ status: 'SUCCEEDED', recordsFound: 2, pagesFetched: 1 });
    expect(writes.probes[0]).toMatchObject({
      channelId: CHANNEL_ID,
      mode: 'probe',
      status: 'SUCCEEDED',
      recordsFound: 2,
      manifestSha256: 'a'.repeat(64),
    });
    expect(writes.updates[0]).toMatchObject({
      probeRequired: false,
      consecutiveFailures: 0,
      lastSuccessAt: NOW,
    });
    expect(writes.events.map((event) => event.event)).toContain('PROBE_PASSED');
    expect(JSON.stringify(result)).not.toContain('sam-secret');
  });

  it('失败（401）：probe 行 FAILED、不解除 probe_required、写 PROBE_FAILED、health_state 记 lastErrorCode', async () => {
    const { prisma, writes } = makePrisma(channelRow());
    const http: ChannelHttpClient = { request: vi.fn(async () => response({}, 401)) };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    const result = await service.probeChannel(CTX, CHANNEL_ID);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'CHANNEL_AUTH_INVALID' });
    expect(writes.probes[0]).toMatchObject({ status: 'FAILED', errorCode: 'CHANNEL_AUTH_INVALID' });
    expect(writes.updates[0]).not.toHaveProperty('probeRequired');
    expect(JSON.stringify(writes.updates[0])).toContain('CHANNEL_AUTH_INVALID');
    expect(writes.events.map((event) => event.event)).toContain('PROBE_FAILED');
  });

  it('0 产出视为失败（试跑语义）：CHANNEL_SCHEMA_MISMATCH', async () => {
    const { prisma, writes } = makePrisma(channelRow());
    const http: ChannelHttpClient = { request: vi.fn(async () => response({ opportunitiesData: [] })) };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    const result = await service.probeChannel(CTX, CHANNEL_ID);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'CHANNEL_SCHEMA_MISMATCH', recordsFound: 0 });
    expect(writes.updates[0]).not.toHaveProperty('probeRequired');
  });

  it('熔断打开过程写 CIRCUIT_OPEN 事件与 health_state', async () => {
    const { prisma, writes } = makePrisma(
      channelRow({
        healthState: { circuit: 'closed', consecutiveFailures: 4, openedUntil: null, lastErrorCode: '500', openMs: null },
      }),
    );
    const http: ChannelHttpClient = { request: vi.fn(async () => response({}, 503)) };
    const service = new ChannelProbeService(prisma as never, resolver, http, () => NOW);
    const result = await service.probeChannel(CTX, CHANNEL_ID);
    expect(result.errorCode).toBe('CHANNEL_UPSTREAM_5XX');
    expect(writes.events.map((event) => event.event)).toEqual(expect.arrayContaining(['CIRCUIT_OPEN', 'PROBE_FAILED']));
    expect(writes.updates[0]!.healthState).toMatchObject({ circuit: 'open' });
  });

  it('sanitizeProbeSample：联系人字段只留命中布尔，其它字段截断', async () => {
    const sample = sanitizeProbeSample([
      { name: 'x'.repeat(300), email: 'a@b.c', phone: '', contactName: 'Jane' },
    ]);
    expect(sample[0]).toEqual({
      name: 'x'.repeat(160),
      email: { present: true },
      phone: { present: false },
      contactName: { present: true },
    });
    expect(() => sanitizeProbeSample(new Array(30).fill({ name: 'a' }))).not.toThrow();
    expect(sanitizeProbeSample(new Array(30).fill({ name: 'a' }))).toHaveLength(20);
  });
});
