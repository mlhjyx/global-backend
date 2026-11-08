import { describe, expect, it } from 'vitest';
import { parseChannelManifest } from './connector/channel-manifest';
import {
  CHANNEL_SOURCE_TYPE_BY_CATEGORY,
  deriveSourcePolicyDrafts,
  evaluateChannelSourcePolicyGate,
  isOfficialSourceHost,
  sourcePolicyUpsertInput,
} from './channel-source-policy';

const CHANNEL = { id: '11111111-1111-4111-8111-111111111111', mode: 'api', category: 'tender' };

function manifest(overrides: Record<string, unknown> = {}) {
  return parseChannelManifest({
    meta: { name: 'SAM.gov', version: 3, category: 'tender' },
    transport: {
      baseUrl: 'https://api.sam.gov',
      responseType: 'json',
      allowedHosts: ['api.sam.gov'],
    },
    rateLimit: { perDomainDelayMs: 1500 },
    records: { itemsPath: '$.items' },
    fieldMapping: { name: '$.title' },
    governance: {
      license: 'public-domain',
      tosUrl: 'https://open.gsa.gov/terms',
      robotsPolicy: 'B',
      personalData: false,
      allowedPurpose: ['discovery', 'intent'],
      retentionDays: 180,
    },
    ...overrides,
  });
}

describe('source_policy 派生（CH-8）', () => {
  it('每个具体 host 一行草稿：domain 去 www、类别映射、限速/保留期/用途照抄', () => {
    const drafts = deriveSourcePolicyDrafts({ ...CHANNEL, category: 'directory' }, manifest({
      transport: {
        baseUrl: 'https://www.example.com',
        responseType: 'json',
        allowedHosts: ['www.example.com', 'api.example.com', '*.example.org', 'www.example.com'],
      },
    }));
    expect(drafts.map((draft) => draft.domain)).toEqual(['example.com', 'api.example.com']);
    expect(drafts[0]).toMatchObject({
      domain: 'example.com',
      sourceType: 'directory',
      accessMode: 'api',
      robotsStatus: 'ALLOWS',
      termsStatus: 'UNREVIEWED',
      personalData: false,
      allowedPurpose: ['discovery', 'intent'],
      crawlDelayMs: 1500,
      retentionDays: 180,
      reviewStatus: 'APPROVED',
    });
    expect(drafts[0]!.notes).toBe(`derived from channel ${CHANNEL.id} manifest v3`);
  });

  it('官方开放数据域：termsStatus 直接 REVIEWED_OK 并注明 official-open-data', () => {
    const drafts = deriveSourcePolicyDrafts(CHANNEL, manifest({
      transport: { baseUrl: 'https://api.gleif.org', responseType: 'json', allowedHosts: ['api.gleif.org'] },
    }));
    expect(drafts[0]).toMatchObject({ domain: 'api.gleif.org', termsStatus: 'REVIEWED_OK' });
    expect(drafts[0]!.notes.startsWith('official-open-data; derived from channel')).toBe(true);
    for (const host of ['api.sam.gov', 'data.europa.eu', 'ec.europa.eu', 'query.wikidata.org', 'overpass-api.de']) {
      expect(isOfficialSourceHost(host), host).toBe(true);
    }
    for (const host of ['example.com', 'gov.example.com', 'europa.eu.evil.com']) {
      expect(isOfficialSourceHost(host), host).toBe(false);
    }
  });

  it('类别映射覆盖全部渠道类别（other→news）', () => {
    expect(CHANNEL_SOURCE_TYPE_BY_CATEGORY).toMatchObject({
      trade_fair: 'trade_fair',
      customs: 'customs',
      association: 'association',
      directory: 'directory',
      tender: 'tender',
      other: 'news',
    });
  });

  it('crawl 形态的 robots 保持 UNREVIEWED（由 probe 实测写入）', () => {
    const drafts = deriveSourcePolicyDrafts({ ...CHANNEL, mode: 'crawl' }, manifest());
    expect(drafts[0]).toMatchObject({ accessMode: 'crawl', robotsStatus: 'UNREVIEWED' });
  });
});

describe('启用条款闸门（只读判定）', () => {
  // 用商业域做违规用例：api.sam.gov 命中 *.gov 官方白名单，会被豁免。
  const HOSTS = ['api.acme-example.com'];
  const OK_ROW = { domain: 'api.acme-example.com', reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS' };

  it('缺行 → POLICY_MISSING；SUSPENDED/UNREVIEWED → 对应原因', () => {
    expect(evaluateChannelSourcePolicyGate({ mode: 'api', hosts: HOSTS, policies: [] })).toEqual([
      { host: 'api.acme-example.com', reason: 'POLICY_MISSING' },
    ]);
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'api', hosts: HOSTS, policies: [{ ...OK_ROW, reviewStatus: 'SUSPENDED' }] }),
    ).toEqual([{ host: 'api.acme-example.com', reason: 'POLICY_SUSPENDED' }]);
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'api', hosts: HOSTS, policies: [{ ...OK_ROW, termsStatus: 'UNREVIEWED' }] }),
    ).toEqual([{ host: 'api.acme-example.com', reason: 'TERMS_UNREVIEWED' }]);
  });

  it('REVIEWED_RESTRICTED 允许；官方域无需行；通配 host 跳过', () => {
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'api', hosts: HOSTS, policies: [{ ...OK_ROW, termsStatus: 'REVIEWED_RESTRICTED' }] }),
    ).toEqual([]);
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'api', hosts: ['api.gleif.org', '*.example.gov'], policies: [] }),
    ).toEqual([]);
  });

  it('crawl 形态额外要求 robotsStatus=ALLOWS（api 不设 robots 门）', () => {
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'crawl', hosts: HOSTS, policies: [{ ...OK_ROW, robotsStatus: 'RESTRICTS' }] }),
    ).toEqual([{ host: 'api.acme-example.com', reason: 'ROBOTS_RESTRICTS' }]);
    expect(
      evaluateChannelSourcePolicyGate({ mode: 'api', hosts: HOSTS, policies: [{ ...OK_ROW, robotsStatus: 'RESTRICTS' }] }),
    ).toEqual([]);
  });

  it('多域一一判定（www 归一后与行匹配）', () => {
    const violations = evaluateChannelSourcePolicyGate({
      mode: 'api',
      hosts: ['www.example.com', 'api.other.example'],
      policies: [
        { domain: 'example.com', reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS' },
        { domain: 'api.other.example', reviewStatus: 'APPROVED', termsStatus: 'UNREVIEWED', robotsStatus: 'ALLOWS' },
      ],
    });
    expect(violations).toEqual([{ host: 'api.other.example', reason: 'TERMS_UNREVIEWED' }]);
  });
});

describe('owner 脚本 upsert 输入', () => {
  it('create 写全量；update 不覆盖 terms/review/robots（人工结论优先）', () => {
    const draft = deriveSourcePolicyDrafts(CHANNEL, manifest())[0]!;
    const input = sourcePolicyUpsertInput(draft);
    expect(input.create).toEqual(draft);
    expect(input.update).not.toHaveProperty('termsStatus');
    expect(input.update).not.toHaveProperty('reviewStatus');
    expect(input.update).not.toHaveProperty('robotsStatus');
    expect(input.update).toMatchObject({ sourceType: 'tender', accessMode: 'api', crawlDelayMs: 1500 });
  });
});
