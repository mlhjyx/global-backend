import { describe, expect, it } from 'vitest';
import { buildSignalIcebreakers } from './signal-icebreaker';
import type { LeadPackageSignalItem } from './enrichment-signal-projection';

describe('buildSignalIcebreakers', () => {
  it('returns empty array when no real signals exist (zero fabrication)', () => {
    expect(buildSignalIcebreakers({ companyName: 'Acme GmbH', signals: [] })).toEqual([]);
  });

  it('generates grounded bilingual ZH/EN openers across all supported signal types with zero PII', () => {
    const signals: LeadPackageSignalItem[] = [
      {
        type: 'TENDER_AWARDED',
        at: '2026-11-25T10:00:00.000Z',
        url: 'https://ted.europa.eu/en/notice/-/detail/654321-2026',
        title: 'EU TED 项目中标公告（654321-2026）',
        excerpt: 'Solar rooftop EPC contract awarded by Stadtwerke',
        provider: 'ted',
      },
      {
        type: 'HIRING_BUYING_ROLE',
        at: '2026-11-24T08:00:00.000Z',
        url: 'https://rhein-epc.de/careers',
        title: '正在招聘采购/供应链相关岗位（3 个开放职位）',
        excerpt: 'Contact hans.mueller@rhein-epc.de or +49 171 9876543 for Head of Procurement',
        provider: 'structured_harvest',
      },
      {
        type: 'AD_CAMPAIGN_ACTIVE',
        at: '2026-11-22T09:00:00.000Z',
        url: 'https://rhein-epc.de/',
        title: '正在投放付费广告（广告像素活跃）',
        excerpt: '检测到广告像素：google_ads, meta_pixel',
        provider: 'digital_footprint',
      },
      {
        type: 'NEWS_MENTION',
        at: '2026-11-20T12:00:00.000Z',
        url: 'https://news.example.de/expansion',
        title: 'Rhein EPC launches new warehouse hub',
        provider: 'rsshub',
      },
    ];

    const suggestions = buildSignalIcebreakers({
      companyName: 'Rhein Solar EPC GmbH',
      signals,
      maxSuggestions: 4,
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions[0]).toMatchObject({
      signalType: 'TENDER_AWARDED',
      signalUrl: 'https://ted.europa.eu/en/notice/-/detail/654321-2026',
      detectedAt: '2026-11-25T10:00:00.000Z',
    });
    expect(suggestions[0]!.openerZh).toContain('Rhein Solar EPC GmbH');
    expect(suggestions[0]!.openerZh).toMatch(/中标|项目/);
    expect(suggestions[0]!.openerEn).toContain('Rhein Solar EPC GmbH');
    expect(suggestions[0]!.openerEn).toMatch(/award|project|tender/i);

    expect(suggestions[1]!.signalType).toBe('HIRING_BUYING_ROLE');
    expect(suggestions[1]!.openerZh).toMatch(/采购|供应链|招聘/);
    expect(suggestions[1]!.openerEn).toMatch(/procurement|supply chain|hiring/i);

    // Zero PII leak in any suggestion field
    const serialized = JSON.stringify(suggestions);
    expect(serialized).not.toContain('hans.mueller@rhein-epc.de');
    expect(serialized).not.toContain('9876543');
  });

  it('drops non-https URLs and supports changedetection PAGE_CHANGE signals', () => {
    const suggestions = buildSignalIcebreakers({
      companyName: 'Nordic Pumps AB',
      signals: [
        {
          type: 'PAGE_CHANGE',
          at: '2026-11-25T09:00:00.000Z',
          url: 'http://insecure.example/diff',
          title: '官网产品页目录更新',
          provider: 'changedetection',
        },
        {
          type: 'WEBSITE_CHANGE',
          at: '2026-11-24T09:00:00.000Z',
          url: 'javascript:alert(1)',
          title: '官网新增新能源板块',
          provider: 'changedetection',
        },
      ],
    });

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.signalUrl).toBeNull();
    expect(suggestions[1]!.signalUrl).toBeNull();
    expect(suggestions[0]!.openerZh).toContain('官网');
    expect(suggestions[0]!.openerEn).toMatch(/website|update/i);
  });
});
