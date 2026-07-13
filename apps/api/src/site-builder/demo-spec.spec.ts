import { describe, expect, it } from 'vitest';
import { buildDemoSpec, collectTextKeys, pickPreset } from './demo-spec';
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

  it('preset 选择：泵类默认 modern-industrial；医疗/电子类词 → precision-light；显式 stylePreset 优先', () => {
    expect(pickPreset(INTAKE)).toBe('modern-industrial');
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
