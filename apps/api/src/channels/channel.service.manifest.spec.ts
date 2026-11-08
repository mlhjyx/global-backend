import { describe, expect, it, vi } from 'vitest';
import { ChannelService } from './channel.service';
import { parseChannelManifest } from './connector/channel-manifest';
import type { ChannelSecretResolver } from './connector/secret-resolver';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const CTX = { workspaceId: WORKSPACE_ID, userId: USER_ID, roles: [] } as never;

const SAMGOV_RAW = {
  meta: { name: 'SAM.gov opportunities', version: 1, category: 'tender' },
  transport: { baseUrl: 'https://api.sam.gov', responseType: 'json', allowedHosts: ['api.sam.gov'] },
  auth: { type: 'apiKey', secretRef: 'channel/samgov/api-key', in: 'query', name: 'api_key' },
  pagination: { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 1000, maxPages: 10 },
  records: { itemsPath: '$.opportunitiesData' },
  fieldMapping: { name: '$.title' },
  governance: {
    license: 'public-domain',
    tosUrl: 'https://open.gsa.gov/terms-and-conditions',
    robotsPolicy: 'B',
    allowedPurpose: ['discovery'],
  },
};
const SAMGOV = parseChannelManifest(SAMGOV_RAW);

/** 非官方域（.gov/.europa.eu 之外的商业 API），用于条款闸门的违规用例。 */
const NON_OFFICIAL_HOST = 'api.acme-example.com';
const NON_OFFICIAL_HOST_URL = `https://${NON_OFFICIAL_HOST}`;
const COMMERCIAL = parseChannelManifest({
  ...SAMGOV_RAW,
  meta: { ...SAMGOV_RAW.meta, name: 'Acme commercial API' },
  transport: { ...SAMGOV_RAW.transport, baseUrl: NON_OFFICIAL_HOST_URL, allowedHosts: [NON_OFFICIAL_HOST] },
});

const HTML_MANIFEST = {
  meta: { name: 'Hannover', version: 1, category: 'trade_fair' },
  transport: { baseUrl: 'https://www.hannovermesse.de', responseType: 'html', allowedHosts: ['www.hannovermesse.de'] },
  crawl: { list: { itemSelector: '.card', url: 'https://www.hannovermesse.de/en/search/?page={page}', maxPages: 5 } },
};

const resolver: ChannelSecretResolver = {
  async resolve(ref: string) {
    if (ref === 'channel/samgov/api-key') return { value: 'sam-secret-value', version: 2, provider: 'file' };
    throw new Error('missing');
  },
};

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    name: 'SAM.gov',
    mode: 'api',
    category: 'tender',
    status: 'DISABLED',
    config: { adapter: 'channel-manifest/v1' },
    manifest: SAMGOV,
    manifestSha256: 'a'.repeat(64),
    manifestVersion: 'channel-manifest/v1',
    connectorKind: 'manifest',
    adapterKey: null,
    baseUrl: 'https://api.sam.gov',
    authRef: { refs: [{ slot: 'secretRef', ref: 'channel/samgov/api-key' }] },
    rateLimit: null,
    pagination: SAMGOV.pagination,
    fieldMapping: SAMGOV.fieldMapping,
    healthState: { circuit: 'closed', consecutiveFailures: 0, openedUntil: null, lastErrorCode: null, openMs: null },
    consecutiveFailures: 0,
    lastSuccessAt: null,
    disabledReason: null,
    quotaPolicy: null,
    probeRequired: true,
    license: 'public-domain',
    tosUrl: 'https://open.gsa.gov/terms-and-conditions',
    robotsPolicy: 'B',
    owner: null,
    failureStreak: 0,
    lastRunAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-09T00:00:00Z'),
    runs: [],
    ...overrides,
  };
}

const DEFAULT_POLICIES = [
  { domain: 'api.sam.gov', reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS' },
];

function makeService(
  state: { channel?: Record<string, unknown> | null; policies?: Array<Record<string, unknown>> } = {},
) {
  const writes = {
    creates: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    policyQueries: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    sourceChannel: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.creates.push(data);
        return channelRow({ ...data, runs: undefined });
      }),
      findUnique: vi.fn(async () => (state.channel === undefined ? channelRow() : state.channel)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.updates.push(data);
        return channelRow({ ...data, runs: undefined });
      }),
      findMany: vi.fn(async () => []),
    },
    sourceChannelHealthEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.events.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
    sourcePolicy: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        writes.policyQueries.push(args);
        return state.policies ?? DEFAULT_POLICIES;
      }),
    },
  };
  const prisma = { withWorkspace: vi.fn(async (_ws: string, cb: (t: typeof tx) => unknown) => cb(tx)) };
  const service = new ChannelService(prisma as never, undefined, resolver);
  return { service, prisma, tx, writes };
}

describe('渠道服务：manifest 导入/编辑/启用门/详情脱敏', () => {
  it('从 manifest 创建渠道：mode/category/列/治理镜像/probe_required 全自动', async () => {
    const { service, writes } = makeService();
    const view = await service.createChannel(CTX, { manifest: SAMGOV_RAW });
    const data = writes.creates[0]!;
    expect(data).toMatchObject({
      name: 'SAM.gov opportunities',
      mode: 'api',
      category: 'tender',
      status: 'DISABLED',
      probeRequired: true,
      connectorKind: 'manifest',
      manifestVersion: 'channel-manifest/v1',
      baseUrl: 'https://api.sam.gov',
      license: 'public-domain',
      tosUrl: 'https://open.gsa.gov/terms-and-conditions',
      robotsPolicy: 'B',
    });
    expect(String(data.manifestSha256)).toMatch(/^[0-9a-f]{64}$/u);
    expect(data.config).toEqual({ adapter: 'channel-manifest/v1' });
    expect(view).toMatchObject({ mode: 'api', probeRequired: true });
    // CH-8：派生草稿随保存返回（不落库；source_policy 由 owner 运营脚本落库）。
    // api.sam.gov 命中 *.gov 官方白名单 → terms 直接 REVIEWED_OK 并注明 official-open-data。
    expect((view as { sourcePolicyDrafts?: unknown[] }).sourcePolicyDrafts).toEqual([
      expect.objectContaining({
        domain: 'api.sam.gov',
        sourceType: 'tender',
        termsStatus: 'REVIEWED_OK',
        reviewStatus: 'APPROVED',
        notes: expect.stringMatching(/^official-open-data; derived from channel .* manifest v1$/u),
      }),
    ]);
    // 商业域默认 UNREVIEWED（等人工条款复核）。
    const commercial = await makeService().service.createChannel(CTX, { manifest: COMMERCIAL });
    expect((commercial as { sourcePolicyDrafts?: Array<{ termsStatus: string }> }).sourcePolicyDrafts?.[0]?.termsStatus).toBe(
      'UNREVIEWED',
    );
  });

  it('manifest 非法 → 400 CHANNEL_MANIFEST_INVALID 且带 issues', async () => {
    const { service } = makeService();
    const error = await service.createChannel(CTX, {
      manifest: { meta: { name: 'X', version: 1, category: 'other' }, transport: { baseUrl: 'http://x.example', responseType: 'json' }, records: { itemsPath: '$.a' } },
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 400, response: { error: { code: 'CHANNEL_MANIFEST_INVALID' } } });
    expect((error as { response: { error: { issues?: unknown[] } } }).response.error.issues?.length).toBeGreaterThan(0);
  });

  it('html manifest v1 不接受（抓取运行链未接 manifest，明确 409）', async () => {
    const { service } = makeService();
    await expect(service.createChannel(CTX, { manifest: HTML_MANIFEST })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_MANIFEST_HTML_UNSUPPORTED' } },
    });
  });

  it('PATCH manifest：重存并重新置 probe_required=true', async () => {
    const { service, writes } = makeService();
    const view = await service.patchChannel(CTX, CHANNEL_ID, {
      manifest: { ...SAMGOV_RAW, meta: { ...SAMGOV_RAW.meta, name: 'SAM.gov v2' } },
    });
    expect(writes.updates[0]).toMatchObject({
      probeRequired: true,
      name: 'SAM.gov v2',
      connectorKind: 'manifest',
    });
    expect(view).toMatchObject({ probeRequired: true, probeUrl: `/source-channels/${CHANNEL_ID}/test` });
  });

  it('已启用渠道换 manifest：保存后回到 DISABLED（未测配置不允许继续跑）', async () => {
    const { service, writes } = makeService({
      channel: channelRow({ status: 'ENABLED', probeRequired: false }),
    });
    await service.patchChannel(CTX, CHANNEL_ID, {
      manifest: { ...SAMGOV_RAW, meta: { ...SAMGOV_RAW.meta, name: 'SAM.gov v3' } },
    });
    expect(writes.updates[0]).toMatchObject({ status: 'DISABLED', probeRequired: true });
  });

  it('manifest 渠道启用前必须 probe 通过：409 CHANNEL_PROBE_REQUIRED', async () => {
    const { service } = makeService({ channel: channelRow({ probeRequired: true }) });
    await expect(service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'CHANNEL_PROBE_REQUIRED' } },
    });
  });

  it('probe 通过后启用：写 MANUAL_ENABLE 健康事件', async () => {
    const { service, writes } = makeService({ channel: channelRow({ probeRequired: false }) });
    await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' });
    expect(writes.updates[0]).toMatchObject({ status: 'ENABLED' });
    expect(writes.events.map((event) => event.event)).toContain('MANUAL_ENABLE');
    // 条款闸门以归一化 domain 查询（www 去掉、通配跳过）。
    expect(writes.policyQueries[0]).toMatchObject({ where: { domain: { in: ['api.sam.gov'] } } });
  });

  it('条款闸门：缺 source_policy 行 → 409 CHANNEL_GOVERNANCE_INCOMPLETE + policyViolations', async () => {
    const { service } = makeService({
      channel: channelRow({ manifest: COMMERCIAL, baseUrl: NON_OFFICIAL_HOST_URL, probeRequired: false }),
      policies: [],
    });
    const error = await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 409, response: { error: { code: 'CHANNEL_GOVERNANCE_INCOMPLETE' } } });
    expect(
      (error as { response: { error: { policyViolations?: unknown[] } } }).response.error.policyViolations,
    ).toEqual([{ host: 'api.acme-example.com', reason: 'POLICY_MISSING' }]);
  });

  it('条款闸门：条款未复核 / 被暂停 → 拒绝启用', async () => {
    for (const [policies, reason] of [
      [[{ domain: 'api.acme-example.com', reviewStatus: 'APPROVED', termsStatus: 'UNREVIEWED', robotsStatus: 'ALLOWS' }], 'TERMS_UNREVIEWED'],
      [[{ domain: 'api.acme-example.com', reviewStatus: 'SUSPENDED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS' }], 'POLICY_SUSPENDED'],
    ] as const) {
      const { service } = makeService({
        channel: channelRow({ manifest: COMMERCIAL, baseUrl: NON_OFFICIAL_HOST_URL, probeRequired: false }),
        policies: [...policies],
      });
      const error = await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' }).catch((cause: unknown) => cause);
      expect(error, reason).toMatchObject({ status: 409, response: { error: { code: 'CHANNEL_GOVERNANCE_INCOMPLETE' } } });
      expect(
        (error as { response: { error: { policyViolations?: unknown[] } } }).response.error.policyViolations,
      ).toEqual([{ host: 'api.acme-example.com', reason }]);
    }
  });

  it('条款闸门：已复核（含 REVIEWED_RESTRICTED）的非官方域可启用', async () => {
    const { service, writes } = makeService({
      channel: channelRow({ manifest: COMMERCIAL, baseUrl: NON_OFFICIAL_HOST_URL, probeRequired: false }),
      policies: [
        { domain: 'api.acme-example.com', reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_RESTRICTED', robotsStatus: 'ALLOWS' },
      ],
    });
    await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' });
    expect(writes.updates[0]).toMatchObject({ status: 'ENABLED' });
  });

  it('条款闸门：官方开放数据域豁免（无 source_policy 行也可启用）', async () => {
    const gleif = parseChannelManifest({
      ...SAMGOV_RAW,
      transport: { baseUrl: 'https://api.gleif.org', responseType: 'json', allowedHosts: ['api.gleif.org'] },
    });
    const { service, writes } = makeService({
      channel: channelRow({ manifest: gleif, baseUrl: 'https://api.gleif.org', probeRequired: false }),
      policies: [],
    });
    await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' });
    expect(writes.updates[0]).toMatchObject({ status: 'ENABLED' });
  });

  it('详情：source_policy 逐域状态、官方标记、违规与派生草稿', async () => {
    const { service } = makeService({ policies: [] });
    const detail = (await service.getChannel(CTX, CHANNEL_ID)) as {
      sourcePolicy: {
        hosts: Array<{ host: string; domain: string; official: boolean }>;
        policies: unknown[];
        violations: unknown[];
        drafts: Array<{ domain: string }>;
      };
    };
    expect(detail.sourcePolicy.hosts).toEqual([{ host: 'api.sam.gov', domain: 'api.sam.gov', official: true }]);
    expect(detail.sourcePolicy.policies).toEqual([]);
    expect(detail.sourcePolicy.violations).toEqual([]); // 官方豁免
    expect(detail.sourcePolicy.drafts.map((draft) => draft.domain)).toEqual(['api.sam.gov']);

    const reviewed = makeService({
      policies: [{ domain: 'api.sam.gov', reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS' }],
    });
    const detail2 = (await reviewed.service.getChannel(CTX, CHANNEL_ID)) as { sourcePolicy: { violations: unknown[] } };
    expect(detail2.sourcePolicy.violations).toEqual([]);
  });

  it('legacy crawl 渠道（manifest=null）沿用既有治理闸门，不被 probe 门拦住', async () => {
    const { service, writes } = makeService({
      channel: channelRow({
        mode: 'crawl',
        manifest: null,
        manifestSha256: null,
        connectorKind: 'manifest',
        probeRequired: true,
        license: 'L',
        tosUrl: 'https://expo.example/terms',
        robotsPolicy: 'A',
        config: { list: { url: 'https://expo.example/x?page={page}', maxPages: 1, itemSelector: '.c' }, detail: { enabled: false, fields: {} } },
      }),
    });
    await service.patchChannel(CTX, CHANNEL_ID, { status: 'ENABLED' });
    expect(writes.updates[0]).toMatchObject({ status: 'ENABLED' });
  });

  it('人工停用写 MANUAL_DISABLE + disabledReason=OPERATOR', async () => {
    const { service, writes } = makeService({ channel: channelRow({ status: 'ENABLED', probeRequired: false }) });
    await service.patchChannel(CTX, CHANNEL_ID, { status: 'DISABLED' });
    expect(writes.updates[0]).toMatchObject({ status: 'DISABLED', disabledReason: 'OPERATOR' });
    expect(writes.events.map((event) => event.event)).toContain('MANUAL_DISABLE');
  });

  it('详情：manifest 可见，密钥只报已配置/未配置（无值、无完整引用）', async () => {
    const { service } = makeService();
    const detail = await service.getChannel(CTX, CHANNEL_ID);
    expect(detail.manifest).toMatchObject({ meta: { name: 'SAM.gov opportunities' } });
    expect(detail.auth).toEqual({
      type: 'apiKey',
      secrets: [{ slot: 'secretRef', name: 'api-key', configured: true }],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('sam-secret-value');
    expect(serialized).not.toContain('authRef');
  });

  it('详情：密钥缺失时 configured=false（不泄露原因）', async () => {
    const { service } = makeService({
      channel: channelRow({
        manifest: parseChannelManifest({
          ...SAMGOV_RAW,
          auth: { type: 'apiKey', secretRef: 'channel/samgov/other', in: 'query', name: 'api_key' },
        }),
      }),
    });
    const detail = await service.getChannel(CTX, CHANNEL_ID);
    expect(detail.auth).toEqual({
      type: 'apiKey',
      secrets: [{ slot: 'secretRef', name: 'other', configured: false }],
    });
  });
});
