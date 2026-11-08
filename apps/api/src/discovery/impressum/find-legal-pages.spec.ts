import { describe, expect, it } from 'vitest';
import { legalPageCandidates, rankLegalPageLinks } from './find-legal-pages';

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
});
