import { describe, expect, it } from 'vitest';
import type { TedContractNotice } from '../adapters/ted-api';
import { OPENFDA_LICENSE, type Fda510kClearance } from '../adapters/openfda-api';
import { companyIdentity } from '../discovery/identity';
import type { SamSourcesSought } from '../adapters/sam-api';
import {
  FDA_PAYLOAD_KEYS,
  SAM_PAYLOAD_KEYS,
  SOURCES_SOUGHT_STRENGTH,
  TED_PAYLOAD_KEYS,
  US_FED_SOURCES_SOUGHT,
  clearanceTtlDays,
  mapFdaClearance,
  mapSamSourcesSought,
  mapTedNotice,
  tenderTtlDays,
} from './signal-mappers';

const OBSERVED = new Date('2026-07-11T00:00:00.000Z');
const DAY_MS = 86_400_000;

const notice = (over?: Partial<TedContractNotice>): TedContractNotice => ({
  publicationNumber: '00123456-2026',
  publicationDateIso: '2026-07-01T00:00:00+02:00',
  cpvCodes: ['42122000'],
  buyerNames: ['Stadt Musterstadt'],
  buyerCountries: ['DEU'],
  deadlines: [],
  ...over,
});

const clearance = (over?: Partial<Fda510kClearance>): Fda510kClearance => ({
  kNumber: 'K261234',
  applicant: 'Aidoc Medical Ltd',
  country: 'IL',
  productCode: 'LLZ',
  decisionDateIso: '2026-05-05T00:00:00.000Z',
  deviceName: 'BriefCase Triage',
  ...over,
});

describe('mapTedNotice —— 招标公告 → 一等 Signal 行', () => {
  it('绿字段齐全 → SignalRow（身份键与租户 canonical 同规范化、CPV 带 scheme 前缀、TTL=90d）', () => {
    const out = mapTedNotice(notice(), OBSERVED);
    expect(out.skip).toBeUndefined();
    const row = out.row!;
    expect(row.providerKey).toBe('ted');
    expect(row.signalType).toBe('TENDER_PUBLISHED');
    expect(row.externalId).toBe('00123456-2026');
    expect(row.subjectName).toBe('Stadt Musterstadt');
    expect(row.subjectCountry).toBe('DE'); // ISO-3 → alpha-2 归一（§8.4 防跨国同名误并）
    expect(row.subjectKey).toBe(companyIdentity({ name: 'Stadt Musterstadt', country: 'DE' }).dedupeKey);
    expect(row.taxonomyKeys).toEqual(['cpv:42122000']);
    expect(row.strength).toBe(0.9);
    expect(row.occurredAt.toISOString()).toBe('2026-06-30T22:00:00.000Z'); // +02:00 归 UTC
    expect(row.observedAt).toEqual(OBSERVED); // 双时间轴：occurred=发布日，observed=摄取时
    expect(row.expiresAt.getTime()).toBe(row.occurredAt.getTime() + tenderTtlDays() * DAY_MS);
    expect(row.license).toBe('CC BY 4.0');
    expect(row.jurisdiction).toBe('EU');
  });

  it('缺买方/缺国别/缺发布日/缺 publicationNumber/缺 CPV → 各自跳过（幂等锚与匹配键缺一不可）', () => {
    expect(mapTedNotice(notice({ buyerNames: [] }), OBSERVED).skip).toBe('no_buyer');
    expect(mapTedNotice(notice({ buyerCountries: [] }), OBSERVED).skip).toBe('no_country');
    expect(mapTedNotice(notice({ publicationDateIso: undefined }), OBSERVED).skip).toBe('no_date');
    expect(mapTedNotice(notice({ publicationDateIso: 'not-a-date' }), OBSERVED).skip).toBe('no_date');
    expect(mapTedNotice(notice({ publicationNumber: undefined }), OBSERVED).skip).toBe('no_external_id');
    expect(mapTedNotice(notice({ cpvCodes: [] }), OBSERVED).skip).toBe('no_taxonomy');
  });

  it('🔴 GDPR 白名单：payload 只含 TED_PAYLOAD_KEYS，对抗输入的具名个人字段绝不入平台绿库', () => {
    const hostile = {
      ...notice(),
      buyerEmail: 'jane.doe@musterstadt.example', // 模拟上游未来扩字段
      contactPerson: 'Jane Doe',
    } as unknown as TedContractNotice;
    const row = mapTedNotice(hostile, OBSERVED).row!;
    expect(Object.keys(row.payload).every((k) => (TED_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(JSON.stringify(row.payload)).not.toContain('jane.doe');
    expect(JSON.stringify(row.payload)).not.toContain('Jane Doe');
  });
});

describe('mapFdaClearance —— 510(k) 清关 → 一等 Signal 行', () => {
  it('绿字段齐全 → SignalRow（fda: 前缀分类键、TTL=365d、CC0 license）', () => {
    const out = mapFdaClearance(clearance(), OBSERVED);
    expect(out.skip).toBeUndefined();
    const row = out.row!;
    expect(row.providerKey).toBe('openfda');
    expect(row.signalType).toBe('FDA_CLEARANCE');
    expect(row.externalId).toBe('K261234');
    expect(row.subjectKey).toBe(companyIdentity({ name: 'Aidoc Medical Ltd', country: 'IL' }).dedupeKey);
    expect(row.taxonomyKeys).toEqual(['fda:LLZ']);
    expect(row.strength).toBe(0.85);
    expect(row.expiresAt.getTime()).toBe(row.occurredAt.getTime() + clearanceTtlDays() * DAY_MS);
    expect(row.license).toBe(OPENFDA_LICENSE);
    expect(row.jurisdiction).toBe('US');
  });

  it('缺国别/缺决定日/缺 kNumber/缺产品码 → 跳过；§6 个体户自然人在**摄取层**即拒（绿库红线前移）', () => {
    expect(mapFdaClearance(clearance({ country: undefined }), OBSERVED).skip).toBe('no_country');
    expect(mapFdaClearance(clearance({ decisionDateIso: undefined }), OBSERVED).skip).toBe('no_date');
    expect(mapFdaClearance(clearance({ kNumber: undefined }), OBSERVED).skip).toBe('no_external_id');
    expect(mapFdaClearance(clearance({ productCode: undefined }), OBSERVED).skip).toBe('no_taxonomy');
    expect(mapFdaClearance(clearance({ applicant: 'Smith, John' }), OBSERVED).skip).toBe('individual');
    expect(mapFdaClearance(clearance({ applicant: 'Dr. Jane Smith' }), OBSERVED).skip).toBe('individual');
  });

  it('🔴 GDPR 白名单：payload 只含 FDA_PAYLOAD_KEYS（contact/us_agent 具名个人绝不入平台绿库）', () => {
    const hostile = {
      ...clearance(),
      contact: 'John Smith',
      usAgent: { name: 'Jane Roe', email: 'jane@agent.example' },
    } as unknown as Fda510kClearance;
    const row = mapFdaClearance(hostile, OBSERVED).row!;
    expect(Object.keys(row.payload).every((k) => (FDA_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(JSON.stringify(row.payload)).not.toContain('jane@agent.example');
    expect(JSON.stringify(row.payload)).not.toContain('John Smith');
  });
});

describe('mapSamSourcesSought —— SAM Sources Sought → signal 行（🔴 PII 白名单 + US 恒定）', () => {
  const OBSERVED = new Date('2026-01-10T00:00:00Z');
  const notice = (over: Partial<SamSourcesSought> = {}): SamSourcesSought => ({
    noticeId: 'ss-abc123',
    title: 'Pump maintenance services',
    department: 'VETERANS AFFAIRS, DEPARTMENT OF',
    subTier: 'VETERANS HEALTH ADMINISTRATION',
    office: 'NCO 1',
    postedDateIso: '2026-01-08T09:00:00.000Z',
    naicsCode: '333914',
    responseDeadlineIso: '2026-02-08T17:00:00.000Z',
    popCountry: 'USA',
    link: 'https://sam.gov/opp/ss-abc123',
    ...over,
  });

  it('机构买方 → signal 行（US 恒定 + naics 分类键 + SOURCES_SOUGHT_STRENGTH）', () => {
    const row = mapSamSourcesSought(notice(), OBSERVED).row!;
    expect(row.providerKey).toBe('samgov');
    expect(row.signalType).toBe(US_FED_SOURCES_SOUGHT);
    expect(row.subjectCountry).toBe('US');
    expect(row.subjectName).toBe('VETERANS AFFAIRS, DEPARTMENT OF — VETERANS HEALTH ADMINISTRATION');
    expect(row.subjectKey).toBe(companyIdentity({ name: row.subjectName, country: 'US' }).dedupeKey);
    expect(row.taxonomyKeys).toEqual(['naics:333914']);
    expect(row.strength).toBe(SOURCES_SOUGHT_STRENGTH);
    expect(row.jurisdiction).toBe('US');
    expect(row.license).toContain('Public Domain');
    // TTL：occurredAt + 120d（默认）
    expect(row.expiresAt.getTime()).toBe(new Date('2026-01-08T09:00:00.000Z').getTime() + 120 * 86_400_000);
  });

  it('Sub-Tier 缺 → 退 Department；都缺 → no_buyer', () => {
    expect(mapSamSourcesSought(notice({ subTier: '' }), OBSERVED).row!.subjectName).toBe('VETERANS AFFAIRS, DEPARTMENT OF');
    expect(mapSamSourcesSought(notice({ department: '', subTier: '' }), OBSERVED).skip).toBe('no_buyer');
  });

  it('缺 noticeId/缺发布日/缺 naics → 各自跳过', () => {
    expect(mapSamSourcesSought(notice({ noticeId: '' }), OBSERVED).skip).toBe('no_external_id');
    expect(mapSamSourcesSought(notice({ postedDateIso: null }), OBSERVED).skip).toBe('no_date');
    expect(mapSamSourcesSought(notice({ naicsCode: '' }), OBSERVED).skip).toBe('no_taxonomy');
  });

  it('🔴 GDPR 白名单：payload 只含 SAM_PAYLOAD_KEYS（联系官/中标方绝不入平台绿库）', () => {
    // 敌意注入：即便上游塞了联系官字段，mapper 手工构造 payload 只取白名单键
    const hostile = { ...notice(), primaryContactFullname: 'Jane Doe', primaryContactEmail: 'jane@va.gov' } as unknown as SamSourcesSought;
    const row = mapSamSourcesSought(hostile, OBSERVED).row!;
    expect(Object.keys(row.payload).every((k) => (SAM_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(true);
    const dumped = JSON.stringify(row.payload).toLowerCase();
    expect(dumped).not.toContain('jane');
    expect(dumped).not.toContain('@va.gov');
  });
});
