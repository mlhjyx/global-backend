import { describe, expect, it } from 'vitest';
import { extractJsonLd, detectAdPixels, detectPlatform, detectServedMarkets } from './digital-footprint.provider';

describe('数字足迹指纹 · 纯解析器', () => {
  it('JSON-LD：抽 Organization 事实 + Product + JobPosting（含 @graph/数组）', () => {
    const html = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[
          {"@type":"Organization","name":"ACME Fabrication GmbH","url":"https://acme.de","foundingDate":"1998","numberOfEmployees":{"@type":"QuantitativeValue","value":"250"},"address":{"addressCountry":"DE"},"sameAs":["https://www.linkedin.com/company/acme"]},
          {"@type":"Product","name":"Laser Cutting Machine X1"},
          {"@type":"JobPosting","title":"Sourcing Manager (m/f/d)","datePosted":"2026-06-01"}
        ]}
      </script>
      <script type="application/ld+json">[{"@type":"Product","name":"Press Brake P200"}]</script>`;
    const f = extractJsonLd(html);
    expect(f.organization?.name).toBe('ACME Fabrication GmbH');
    expect(f.organization?.employees).toBe(250);
    expect(f.organization?.country).toBe('DE');
    expect(f.products).toContain('Laser Cutting Machine X1');
    expect(f.products).toContain('Press Brake P200');
    expect(f.jobPostings[0]).toEqual({ title: 'Sourcing Manager (m/f/d)', datePosted: '2026-06-01' });
  });

  it('JSON-LD：畸形块跳过不崩', () => {
    const f = extractJsonLd(`<script type="application/ld+json">{bad json,,}</script>`);
    expect(f.organization).toBeUndefined();
    expect(f.products).toEqual([]);
  });

  it('广告像素：区分投放型(is_advertiser) vs 分析型', () => {
    const html = `<script>fbq('init','123');</script><script src="https://snap.licdn.com/li.lms-analytics/insight.min.js"></script>`;
    const pixels = detectAdPixels(html);
    expect(pixels).toContain('meta_pixel');
    expect(pixels).toContain('linkedin_insight');
    expect(detectAdPixels('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC"></script>')).toEqual(['google_analytics']);
  });

  it('技术栈平台：HTML + 响应头双路检测', () => {
    expect(detectPlatform('<link href="https://cdn.shopify.com/s/x.css">')).toContain('shopify');
    expect(detectPlatform('<div class="woocommerce"><script src="/wp-content/plugins/woocommerce/x.js">')).toEqual(
      expect.arrayContaining(['woocommerce', 'wordpress']),
    );
    expect(detectPlatform('<html></html>', { 'x-shopify-stage': 'production' })).toContain('shopify');
  });

  it('服务市场：hreflang → 语言 + 国家（忽略 x-default）', () => {
    const html = `
      <link rel="alternate" hreflang="x-default" href="/">
      <link rel="alternate" hreflang="en-US" href="/us">
      <link rel="alternate" hreflang="de-DE" href="/de">
      <link rel="alternate" hreflang="zh" href="/zh">`;
    const m = detectServedMarkets(html);
    expect(m.countries).toEqual(expect.arrayContaining(['US', 'DE']));
    expect(m.langs).toEqual(expect.arrayContaining(['en', 'de', 'zh']));
    expect(m.countries).not.toContain('DEFAULT');
  });
});
