import { describe, expect, it } from 'vitest';
import { buildDemoSpec, buildIndustrialSpec, buildSiteSpec, collectTextKeys, pickPreset, pickTemplate, sanitizePolish } from './demo-spec';
import type { IntakeInput } from './intake.service';

const INTAKE: IntakeInput = {
  company: { nameZh: '杭州爱克姆泵业', nameEn: 'Acme Pump Co., Ltd.' },
  industry: 'isic-2813',
  products: ['centrifugal pump', 'screw pump'],
  targetMarkets: ['DE', 'US'],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: 'sales@acmepump.com',
};

describe('buildDemoSpec（demo v0：行业模板 + 注册信息填充，02 §4 快速通道）', () => {
  it('结构：home/products/contact 三页，home 首块 HeroBanner，contact 含 InquiryForm，nav 指向存在页面', () => {
    const doc = buildDemoSpec({ siteName: 'Acme Pump Co., Ltd.', intake: INTAKE });
    expect(doc.pages.map((p) => p.id)).toEqual(['home', 'products', 'contact']);
    expect(doc.pages[0].puck.content[0].type).toBe('HeroBanner');
    const contact = doc.pages.find((p) => p.id === 'contact')!;
    expect(contact.puck.content.some((b) => b.type === 'InquiryForm')).toBe(true);
    const pageIds = new Set(doc.pages.map((p) => p.id));
    for (const n of doc.site.nav) expect(pageIds.has(n.pageId)).toBe(true);
  });

  it('文案只用注册事实：公司名/产品/目标市场入 bundle，不虚构年限或认证', () => {
    const doc = buildDemoSpec({ siteName: 'Acme Pump Co., Ltd.', intake: INTAKE });
    const en = doc.copyBundles.en;
    const all = Object.values(en).join(' ');
    expect(all).toContain('Acme Pump Co., Ltd.');
    expect(all.toLowerCase()).toContain('centrifugal pump');
    expect(all).toContain('Germany');
    expect(all).toContain('United States');
    // 零虚构红线：demo 不得声称年限/认证/工厂面积（intake 没有这些事实）
    expect(all).not.toMatch(/\d+\s*(\+\s*)?years/i);
    expect(all).not.toMatch(/ISO\s*9001|CE certified/i);
  });

  it('textKey 完整性：spec 引用的所有 key（含组件内建 key）在 bundle 中存在', () => {
    const doc = buildDemoSpec({ siteName: 'Acme Pump Co., Ltd.', intake: INTAKE });
    const keys = collectTextKeys(doc);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(doc.copyBundles.en[key], `missing copy for ${key}`).toBeTruthy();
    }
  });

  it('preset 选择：制造类(泵) -> industrial-trumpf；医疗/电子类词 → precision-light；显式 stylePreset 优先', () => {
    expect(pickPreset(INTAKE)).toBe('industrial-trumpf'); // 泵 = 制造 -> trumpf 风
    expect(pickPreset({ ...INTAKE, products: ['battery storage', 'solar inverter'] })).toBe('industrial-tecloman');
    expect(pickPreset({ ...INTAKE, products: ['yoga mat', 'yoga pants'] })).toBe('modern-industrial');
    expect(
      pickPreset({ ...INTAKE, products: ['ultrasound probe', 'medical device housing'] }),
    ).toBe('precision-light');
    const doc = buildDemoSpec({
      siteName: 'X',
      intake: INTAKE,
      stylePreset: 'precision-light',
    });
    expect(doc.site.theme.preset).toBe('precision-light');
  });

  it('sanitizePolish：虚构指征（年限/认证/产能）命中即弃字段，干净文案放行', () => {
    expect(
      sanitizePolish({
        headline: 'Reliable Pumps for Global Buyers',
        subhead: 'With 20+ years of experience and ISO 9001 certification.',
        aboutBody: 'A CE certified factory of 15,000 sqm with 300 workers.',
      }),
    ).toEqual({ headline: 'Reliable Pumps for Global Buyers' });
    expect(sanitizePolish(undefined)).toEqual({});
    expect(sanitizePolish({ headline: '   ', subhead: 'x'.repeat(501) })).toEqual({});
  });

  it('polish 覆盖 hero/about 文案；缺省用确定性模板', () => {
    const plain = buildDemoSpec({ siteName: 'Acme', intake: INTAKE });
    const polished = buildDemoSpec({
      siteName: 'Acme',
      intake: INTAKE,
      polish: { headline: 'Reliable Pumps, Proven Worldwide' },
    });
    expect(polished.copyBundles.en['home.hero.headline']).toBe('Reliable Pumps, Proven Worldwide');
    expect(plain.copyBundles.en['home.hero.headline']).toContain('Acme');
    expect(polished.copyBundles.en['about.body']).toBe(plain.copyBundles.en['about.body']);
  });
});

describe('buildIndustrialSpec / buildSiteSpec（B2B 工业模板，distill trumpf+tecloman）', () => {
  it('pickTemplate：制造类(泵) -> industrial；非制造 -> demo', () => {
    expect(pickTemplate(INTAKE)).toBe('industrial');
    expect(pickTemplate({ ...INTAKE, products: ['yoga mat', 'yoga pants'] })).toBe('demo');
  });

  it('buildSiteSpec 分发：制造类走 industrial（home 含 StatsBand + trumpf preset）；非制造走 demo（无 StatsBand）', () => {
    const industrial = buildSiteSpec({ siteName: 'Acme Pump Co., Ltd.', intake: INTAKE });
    expect(industrial.pages[0].puck.content.some((b) => b.type === 'StatsBand')).toBe(true);
    expect(industrial.site.theme.preset).toBe('industrial-trumpf');

    const demo = buildSiteSpec({
      siteName: 'Yoga Co',
      intake: { ...INTAKE, products: ['yoga mat', 'yoga pants'] },
    });
    expect(demo.pages[0].puck.content.some((b) => b.type === 'StatsBand')).toBe(false);
    expect(demo.site.theme.preset).toBe('modern-industrial');
  });

  it('industrial home 结构：Hero -> Stats -> Products -> About -> Process -> FAQ -> CTA', () => {
    const doc = buildIndustrialSpec({ siteName: 'Acme', intake: INTAKE });
    expect(doc.pages.map((p) => p.id)).toEqual(['home', 'products', 'contact']);
    const types = doc.pages[0].puck.content.map((b) => b.type);
    expect(types).toEqual([
      'HeroBanner',
      'TrustBar',
      'StatsBand',
      'ProductGrid',
      'FactoryShowcase',
      'CaseStudies',
      'Testimonials',
      'AboutBlock',
      'ProcessTimeline',
      'RegionsGrid',
      'NewsList',
      'FaqAccordion',
      'CtaBanner',
    ]);
    // 内页 PageHeader
    const products = doc.pages.find((p) => p.id === 'products')!;
    expect(products.puck.content[0].type).toBe('PageHeader');
    const contact = doc.pages.find((p) => p.id === 'contact')!;
    expect(contact.puck.content[0].type).toBe('PageHeader');
    expect(contact.puck.content.some((b) => b.type === 'InquiryForm')).toBe(true);
    // RegionsGrid 用 intake 出口市场（零虚构）
    const regions = doc.pages[0].puck.content.find((b) => b.type === 'RegionsGrid')!.props
      .regions as { code: string }[];
    expect(regions.map((r) => r.code)).toEqual(INTAKE.targetMarkets);
  });

  it('零虚构红线：StatsBand 只用 intake 派生事实（产品线数/市场数），文案不编造年限/认证/产能', () => {
    const doc = buildIndustrialSpec({ siteName: 'Acme', intake: INTAKE });
    const stats = doc.pages[0].puck.content.find((b) => b.type === 'StatsBand')!.props
      .stats as { value: string; labelKey: string }[];
    expect(stats[0].value).toBe(String(INTAKE.products.length)); // 2 产品线
    expect(stats[1].value).toBe(String(INTAKE.targetMarkets.length)); // 2 出口市场
    const all = Object.values(doc.copyBundles.en).join(' ');
    expect(all).not.toMatch(/\d+\s*(\+\s*)?years/i);
    expect(all).not.toMatch(/ISO\s*9001|CE certified/i);
  });

  it('textKey 完整性：industrial spec 引用的所有 key 在 bundle 中存在（无 ⟦ 缺 key）', () => {
    const doc = buildIndustrialSpec({ siteName: 'Acme', intake: INTAKE });
    const keys = collectTextKeys(doc);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(doc.copyBundles.en[key], `missing copy for ${key}`).toBeTruthy();
    }
  });

  it('polish 覆盖 industrial hero 文案；显式 stylePreset 优先于 pickPreset', () => {
    const polished = buildIndustrialSpec({
      siteName: 'Acme',
      intake: INTAKE,
      polish: { headline: 'Engineered Pumps, Exported Worldwide' },
      stylePreset: 'industrial-tecloman',
    });
    expect(polished.copyBundles.en['home.hero.headline']).toBe('Engineered Pumps, Exported Worldwide');
    expect(polished.site.theme.preset).toBe('industrial-tecloman');
  });
});
