import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { ToolPolicyDenied } from '../../tools/tool-broker';
import {
  DigitalFootprintProvider,
  extractJsonLd,
  detectAdPixels,
  detectPlatform,
  detectServedMarkets,
  pickProductPageUrls,
} from './digital-footprint.provider';

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

  it('JSON-LD：只从明确 manufacturer/seller/Offer 提取商业模式事实，brand 单独出现不算', () => {
    const explicit = extractJsonLd(`
      <script type="application/ld+json">{"@graph":[
        {"@id":"#maker","@type":"Organization","name":"ACME Manufacturing GmbH"},
        {"@type":"Product","name":"Laser X1","brand":{"@type":"Brand","name":"ACME"},
         "manufacturer":{"@id":"#maker"},
         "offers":{"@type":"Offer","seller":{"@type":"Organization","name":"ACME Direct"}}}
      ]}</script>`);
    const brandOnly = extractJsonLd(`
      <script type="application/ld+json">
        {"@type":"Product","name":"Laser X1","brand":{"@type":"Brand","name":"ACME"}}
      </script>`);

    expect(explicit.businessModels).toEqual([
      'manufacturer:ACME Manufacturing GmbH',
      'seller:ACME Direct',
      'official_product_offer',
    ]);
    expect(brandOnly.businessModels).toEqual([]);
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

  it('Crawl4AI 不可用时经 ToolBroker http.get 降级，仍提取官网产品事实', async () => {
    const html = `${'<meta name="pad" content="x">'.repeat(10)}
      <script type="application/ld+json">{"@type":"Product","name":"Laser Cutting Machine X1"}</script>`;
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'crawl4ai.render') throw new Error('crawler unavailable');
      if (toolId === 'http.get') {
        return { data: { status: 200, ok: true, text: html, finalUrl: 'https://acme.example/' }, costCents: 0 };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed: async () => true,
    });

    const result = await provider.enrichCompany(
      { name: 'Acme', domain: 'acme.example' },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );

    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['crawl4ai.render', 'http.get']);
    expect(result).toMatchObject({
      matched: true,
      attributes: { structured_products: ['Laser Cutting Machine X1'] },
      provenance: { sourceUrl: 'https://acme.example/' },
    });
  });

  it('合规拒绝是终止结论，不用 http.get 绕过策略闸门', async () => {
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'crawl4ai.render') throw new ToolPolicyDenied(toolId, 'suspended');
      throw new Error(`must not fallback to ${toolId}`);
    });
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed: async () => true,
    });

    await expect(
      provider.enrichCompany(
        { name: 'Acme', domain: 'acme.example' },
        { workspaceId: 'ws-1', runId: 'run-1' },
      ),
    ).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('从 sitemap 中只挑同站产品路径，排除列表页和新闻页', () => {
    expect(
      pickProductPageUrls([
        'https://acme.example/products',
        'https://acme.example/products/laser-x1',
        'https://acme.example/de/produkte/press-brake-p200',
        'https://acme.example/products/category/cutting',
        'https://acme.example/news/product-launch',
        'https://other.example/products/not-ours',
      ], 'acme.example'),
    ).toEqual([
      'https://acme.example/products/laser-x1',
      'https://acme.example/de/produkte/press-brake-p200',
    ]);
  });

  it('资格取证时复用 sitemap，最多试 3 个产品页并在首个真实 Product 命中后停止', async () => {
    const home = '<html><body>Company homepage without product schema</body></html>'.padEnd(220, ' ');
    const foreignProduct = `${'<meta name="pad" content="x">'.repeat(10)}
      <script type="application/ld+json">{"@type":"Product","name":"Foreign Redirect Product"}</script>`;
    const product = `${'<meta name="pad" content="x">'.repeat(10)}
      <script type="application/ld+json">{"@type":"Product","name":"Laser Cutting Machine X1"}</script>`;
    const invoke = vi.fn(async (toolId: string, input: { url?: string }) => {
      if (toolId === 'crawl4ai.render') {
        return { data: { url: 'https://acme.example/', html: home, headers: {} }, costCents: 0 };
      }
      if (toolId === 'http.get' && input.url?.endsWith('/products/family')) {
        return {
          data: {
            status: 200,
            ok: true,
            text: foreignProduct,
            finalUrl: 'https://unrelated.example/products/foreign',
          },
          costCents: 0,
        };
      }
      if (toolId === 'http.get' && input.url?.endsWith('/products/laser-x1')) {
        return { data: { status: 200, ok: true, text: product, finalUrl: input.url }, costCents: 0 };
      }
      throw new Error(`unexpected ${toolId} ${input.url}`);
    });
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed: async () => true,
      sitemapUrls: async () => [
        'https://acme.example/products/family',
        'https://acme.example/products/laser-x1',
        'https://acme.example/products/unused-third',
        'https://acme.example/products/unused-fourth',
      ],
    });

    const result = await provider.enrichCompany(
      { name: 'Acme', domain: 'acme.example', purpose: 'fit_evidence' },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );

    expect(result).toMatchObject({
      matched: true,
      attributes: { structured_products: ['Laser Cutting Machine X1'] },
      provenance: { sourceUrl: 'https://acme.example/products/laser-x1' },
    });
    expect(result.attributes).toEqual({
      structured_products: ['Laser Cutting Machine X1'],
      fit_evidence_version: 'digital-footprint/v3',
    });
    expect(invoke.mock.calls.filter((call) => call[0] === 'http.get')).toHaveLength(2);
  });

  it('首页允许但产品路径被 robots 拒绝时，不请求该产品页', async () => {
    const home = '<html><body>Company homepage without product schema</body></html>'.padEnd(220, ' ');
    const invoke = vi.fn(async (toolId: string, input: { url?: string }) => {
      if (toolId === 'crawl4ai.render') {
        return { data: { url: 'https://acme.example/', html: home, headers: {} }, costCents: 0 };
      }
      throw new Error(`robots-denied URL must not be requested: ${toolId} ${input.url}`);
    });
    const robotsAllowed = vi.fn(async (url: string) => url === 'https://acme.example/');
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed,
      sitemapUrls: async () => ['https://acme.example/products/laser-x1'],
    });

    await expect(
      provider.enrichCompany(
        { name: 'Acme', domain: 'acme.example', purpose: 'fit_evidence' },
        { workspaceId: 'ws-1', runId: 'run-1' },
      ),
    ).resolves.toMatchObject({ matched: false, attributes: {} });
    expect(robotsAllowed).toHaveBeenCalledWith('https://acme.example/products/laser-x1', expect.any(Object));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('产品路径 robots 状态不可用时 fail closed，不请求该产品页', async () => {
    const home = '<html><body>Company homepage without product schema</body></html>'.padEnd(220, ' ');
    const invoke = vi.fn(async (toolId: string, input: { url?: string }) => {
      if (toolId === 'crawl4ai.render') {
        return { data: { url: 'https://acme.example/', html: home, headers: {} }, costCents: 0 };
      }
      throw new Error(`robots-unknown URL must not be requested: ${toolId} ${input.url}`);
    });
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed: async (url) => {
        if (url === 'https://acme.example/') return true;
        throw new Error('robots unavailable');
      },
      sitemapUrls: async () => ['https://acme.example/products/laser-x1'],
    });

    await expect(
      provider.enrichCompany(
        { name: 'Acme', domain: 'acme.example', purpose: 'fit_evidence' },
        { workspaceId: 'ws-1', runId: 'run-1' },
      ),
    ).resolves.toMatchObject({ matched: false, attributes: {} });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('资格取证只在产品 JSON-LD 有明确交易/制造字段时写入 business_model', async () => {
    const home = '<html><body>Company homepage without product schema</body></html>'.padEnd(220, ' ');
    const product = `${'<meta name="pad" content="x">'.repeat(10)}
      <script type="application/ld+json">{
        "@type":"Product",
        "name":"Laser Cutting Machine X1",
        "manufacturer":{"@type":"Organization","name":"ACME GmbH"},
        "offers":{"@type":"Offer","seller":{"@type":"Organization","name":"ACME Direct"}}
      }</script>`;
    const invoke = vi.fn(async (toolId: string, input: { url?: string }) => {
      if (toolId === 'crawl4ai.render') {
        return { data: { url: 'https://acme.example/', html: home, headers: {} }, costCents: 0 };
      }
      return { data: { status: 200, ok: true, text: product, finalUrl: input.url }, costCents: 0 };
    });
    const provider = new DigitalFootprintProvider({
      broker: { invoke, checkSourcePolicy: vi.fn() } as unknown as ExecutionBroker,
      robotsAllowed: async () => true,
      sitemapUrls: async () => ['https://acme.example/products/laser-x1'],
    });

    const result = await provider.enrichCompany(
      { name: 'Acme', domain: 'acme.example', purpose: 'fit_evidence' },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );

    expect(result.attributes).toEqual({
      structured_products: ['Laser Cutting Machine X1'],
      business_model: ['manufacturer:ACME GmbH', 'seller:ACME Direct', 'official_product_offer'],
      fit_evidence_version: 'digital-footprint/v3',
    });
  });

  it('资格取证没有 Product 时返回 miss，不把广告像素/MX 冒充业务证据', async () => {
    const html = `<html><script>fbq('init','123')</script></html>`.padEnd(220, ' ');
    const provider = new DigitalFootprintProvider({
      broker: {
        invoke: vi.fn(async () => ({ data: { url: 'https://acme.example/', html, headers: {} }, costCents: 0 })),
        checkSourcePolicy: vi.fn(),
      } as unknown as ExecutionBroker,
      robotsAllowed: async () => true,
      sitemapUrls: async () => [],
    });

    await expect(
      provider.enrichCompany(
        { name: 'Acme', domain: 'acme.example', purpose: 'fit_evidence' },
        { workspaceId: 'ws-1', runId: 'run-1' },
      ),
    ).resolves.toMatchObject({ matched: false, attributes: {} });
  });
});
