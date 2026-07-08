import { describe, expect, it } from 'vitest';
import { TedDiscoveryProvider, mapNoticeToRecords, toAlpha2 } from './ted.provider';
import { TedAwardNotice } from '../../adapters/ted-api';
import { CompanyDiscoveryQuery } from '../provider-contract';

const NOW = '2026-07-08T00:00:00.000Z';

function notice(overrides: Partial<TedAwardNotice> = {}): TedAwardNotice {
  return {
    publicationNumber: '123456-2026',
    publicationDate: '2026-07-08+02:00',
    noticeType: 'can-standard',
    formType: 'result',
    cpvCodes: ['42120000'],
    buyerNames: ['City of Munich'],
    buyerCountries: ['DEU'],
    winners: [],
    ...overrides,
  };
}

function q(filters: Record<string, unknown>): CompanyDiscoveryQuery {
  return { sourceClass: 'public_intelligence', filters, keywords: [], limit: 25 };
}

describe('TED 中标方 → ProviderCompanyRecord（mapNoticeToRecords）', () => {
  it('单中标方带官网 → 域名可解析 + ted 命名空间事实 + 署名', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [{ name: 'Acme Pumps Ltd', country: 'DEU', identifier: 'DE111', internetAddress: 'https://acme-pumps.example' }] }),
      NOW,
    );
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.name).toBe('Acme Pumps Ltd');
    expect(r.domain).toBe('acme-pumps.example');
    expect(r.country).toBe('DE'); // §8.3：ISO-3 DEU → alpha-2 DE
    const ted = r.attributes?.ted as Record<string, unknown>;
    expect(ted.publication_number).toBe('123456-2026');
    expect(ted.cpv).toEqual(['42120000']);
    expect(ted.winner_identifier).toBe('DE111');
    expect(ted.license).toBe('CC-BY-4.0');
    expect(String(ted.attribution)).toMatch(/European Union/i);
    expect(r.provenance?.parserVersion).toBe('ted/v1');
  });

  it('🔴 合规：绿事实记录里绝不含具名邮箱/个人联系点', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [{ name: 'Acme Pumps Ltd', country: 'DEU', identifier: 'DE111' }] }),
      NOW,
    );
    const serialized = JSON.stringify(recs);
    expect(serialized).not.toMatch(/email/i);
    expect(serialized).not.toContain('@');
  });

  it('多中标方无官网 → 走 name+country（domain 不臆造，绝不贴错身份）', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [
        { name: 'Alpha AG', country: 'DEU' },
        { name: 'Beta SA', country: 'FRA' },
      ] }),
      NOW,
    );
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.domain === undefined)).toBe(true);
    expect(recs.map((r) => r.externalId)).toEqual(['ted:123456-2026:0', 'ted:123456-2026:1']);
  });

  it('中标方无 identifier → winner_identifier 字段被裁剪（不落空值）', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: 'Gamma GmbH', country: 'DEU' }] }), NOW);
    const ted = recs[0].attributes?.ted as Record<string, unknown>;
    expect('winner_identifier' in ted).toBe(false);
  });

  it('空名中标方被过滤', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: '  ' }, { name: 'Real Co' }] }), NOW);
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('Real Co');
  });

  it('§8.3 国别 ISO-3 → alpha-2（canonical 一致，防跨源 dedupe 裂键）', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: 'Acme AG', country: 'DEU' }] }), NOW);
    expect(recs[0].country).toBe('DE');
  });
});

describe('§8.3 toAlpha2 国别归一', () => {
  it('TED 覆盖集 ISO-3 → alpha-2', () => {
    expect(toAlpha2('DEU')).toBe('DE');
    expect(toAlpha2('FRA')).toBe('FR');
    expect(toAlpha2('GBR')).toBe('GB');
  });
  it('未收录码保留原值（best-effort，不静默出错）', () => {
    expect(toAlpha2('ZZZ')).toBe('ZZZ');
  });
  it('空值透传', () => {
    expect(toAlpha2(undefined)).toBeUndefined();
  });
});

describe('TedDiscoveryProvider 契约', () => {
  it('key=ted，class=public_intelligence（复用类，无需新 SourceClass）', () => {
    const p = new TedDiscoveryProvider();
    expect(p.key).toBe('ted');
    expect(p.classes).toEqual(['public_intelligence']);
  });

  it('无 CPV 过滤 → 直接返回空（fail-safe，不发网络请求、不裸拉全库）', async () => {
    const p = new TedDiscoveryProvider();
    const res = await p.discoverCompanies(q({}));
    expect(res).toEqual({ records: [], costCents: 0 });
  });
});
