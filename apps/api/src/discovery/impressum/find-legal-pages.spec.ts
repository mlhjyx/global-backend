import { describe, expect, it } from 'vitest';
import { isStrictContactPageUrl, legalPageCandidates, rankLegalPageLinks } from './find-legal-pages';

/**
 * A1：法律页发现的确定性规则（链接评分 + 固定路径探测）。DE/AT/CH 公司站点的
 * Impressum 路径形态覆盖：/impressum、/impressum.html、/impressum/、/imprint、
 * /legal-notice、/kontakt、非标准（/ando-technik/impressum/）。
 */
describe('rankLegalPageLinks（链接评分）', () => {
  it('impressum/imprint 权重最高，contact 次之，about 仅兜底', () => {
    const ranked = rankLegalPageLinks([
      'https://a.de/ueber-uns',
      'https://a.de/kontakt',
      'https://a.de/impressum',
    ]);
    expect(ranked.map((r) => r.kind)).toEqual(['impressum', 'contact', 'about']);
  });

  it('非标准路径里的 impressum 也能识别，并保留站点给的原始形态', () => {
    const ranked = rankLegalPageLinks(['https://a.de/ando-technik/impressum/']);
    expect(ranked[0]).toMatchObject({ kind: 'impressum', url: 'https://a.de/ando-technik/impressum/' });
  });

  it('忽略资产/隐私/条款类链接', () => {
    const ranked = rankLegalPageLinks([
      'https://a.de/privacy-policy',
      'https://a.de/terms',
      'https://a.de/images/impressum.png',
    ]);
    expect(ranked).toEqual([]);
  });

  it('includePrivacy=true 时可发现 informativa-privacy / datenschutz / JP 会社概要 页面', () => {
    const ranked = rankLegalPageLinks(
      [
        'https://a.it/informativa-privacy',
        'https://a.de/datenschutz',
        'https://a.jp/%E4%BC%9A%E7%A4%BE%E6%A6%82%E8%A6%81',
      ],
      { includePrivacy: true },
    );
    expect(ranked.map((r) => [r.url, r.kind, r.score])).toEqual([
      ['https://a.jp/%E4%BC%9A%E7%A4%BE%E6%A6%82%E8%A6%81', 'impressum', 100],
      ['https://a.de/datenschutz', 'impressum', 70],
      ['https://a.it/informativa-privacy', 'impressum', 70],
    ]);
  });

  it('同一路径的不同形态只留一条（带斜杠优先由调用方保证，此处按归一键去重）', () => {
    const ranked = rankLegalPageLinks(['https://a.de/impressum', 'https://a.de/impressum/']);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.url).toBe('https://a.de/impressum/');
  });
});

describe('legalPageCandidates（首页链接 + 固定路径探测）', () => {
  it('优先用首页链接；缺 impressum/contact 时用固定路径补齐；总数受上限约束', () => {
    const candidates = legalPageCandidates('https://a.de/', ['https://a.de/kontakt'], { maxPages: 4 });
    expect(candidates[0]).toMatchObject({ kind: 'contact', url: 'https://a.de/kontakt' });
    const kinds = candidates.map((c) => c.kind);
    expect(kinds).toContain('impressum');
    expect(candidates.length).toBeLessThanOrEqual(4);
    // 固定路径候选都在同一 host 上
    for (const c of candidates) expect(new URL(c.url).hostname).toBe('a.de');
  });

  it('首页已链接的 impressum 不重复追加固定路径', () => {
    const candidates = legalPageCandidates('https://a.de/', ['https://a.de/impressum'], { maxPages: 6 });
    const impressum = candidates.filter((c) => c.url.includes('impressum'));
    expect(impressum).toHaveLength(1);
  });

  it('首页什么都没有时仍给出固定路径候选（探测），impressum 排最前', () => {
    const candidates = legalPageCandidates('https://a.de/', [], { maxPages: 3 });
    expect(candidates[0]!.kind).toBe('impressum');
    expect(candidates[0]!.url).toBe('https://a.de/impressum');
  });

  it('#96-2 回归：严格按完整路径段匹配联系页，拒绝 phoenix-contact 等商品/品牌路径', () => {
    const ranked = rankLegalPageLinks([
      'https://memodo.it/fotovoltaico/accessori/phoenix-contact/',
      'https://memodo.it/prodotti/contatti-elettrici',
      'https://memodo.it/shop/contact-kit',
      'https://memodo.it/it/contatti/',
      'https://memodo.it/contatti',
    ]);
    expect(ranked.map((r) => r.url)).toEqual([
      'https://memodo.it/contatti',
      'https://memodo.it/it/contatti/',
    ]);
    expect(isStrictContactPageUrl('https://memodo.it/fotovoltaico/accessori/phoenix-contact/')).toBe(false);
    expect(isStrictContactPageUrl('https://memodo.it/products/phoenix-contact')).toBe(false);
    expect(isStrictContactPageUrl('https://memodo.it/contatti')).toBe(true);
    expect(isStrictContactPageUrl('https://memodo.it/en/contact-us.html')).toBe(true);
    expect(isStrictContactPageUrl('https://memodo.it/contact/form')).toBe(true);
  });
});
