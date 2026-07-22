import { describe, expect, it } from "vitest";
import {
  QUALIFIED_COMPONENT_CONTENT_BUDGETS,
  SITE_SPEC_VERSION,
  assertQualifiedComponentContentBudget,
  type SiteSpec,
} from "@global/contracts";
import {
  buildDemoSpec,
  collectTextKeys,
  DEMO_SPEC_VERSION,
  pickPreset,
  sanitizePolish,
} from "./demo-spec";
import type { IntakeInput } from "./intake.service";

const INTAKE: IntakeInput = {
  company: { nameZh: "杭州爱克姆泵业", nameEn: "Acme Pump Co., Ltd." },
  industry: "isic-2813",
  products: ["centrifugal pump", "screw pump"],
  targetMarkets: ["DE", "US"],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: "sales@acmepump.com",
};

describe("DQ-1 契约守卫：demo 生产端符合 @global/contracts 的 SiteSpec 信封", () => {
  it("版本一致：DEMO_SPEC_VERSION 等于契约 SITE_SPEC_VERSION（demo 恒发当前契约版本）", () => {
    expect(DEMO_SPEC_VERSION).toBe(SITE_SPEC_VERSION);
  });

  it("信封形状：产出可赋给 SiteSpec，顶层字段齐备（编译期赋值 + 运行期断言双守）", () => {
    // 编译期：若生产端漂移出契约，此赋值即类型报错——这正是 DQ-1 单一真值的意义。
    const doc: SiteSpec = buildDemoSpec({
      siteName: "Acme Pump Co., Ltd.",
      intake: INTAKE,
    });
    expect(typeof doc.specVersion).toBe("string");
    expect(typeof doc.site.defaultLocale).toBe("string");
    expect(Array.isArray(doc.site.locales)).toBe(true);
    expect(typeof doc.site.theme.preset).toBe("string");
    expect(Array.isArray(doc.site.nav)).toBe(true);
    expect(typeof doc.site.seoGlobal.siteName).toBe("string");
    expect(Array.isArray(doc.pages)).toBe(true);
    expect(typeof doc.assets).toBe("object");
    expect(typeof doc.copyBundles).toBe("object");
  });
});

describe("buildDemoSpec（demo v0：行业模板 + 注册信息填充，02 §4 快速通道）", () => {
  it("结构：home/products/contact 三页，home 首块 HeroBanner，contact 含 InquiryForm，nav 指向存在页面", () => {
    const doc = buildDemoSpec({
      siteName: "Acme Pump Co., Ltd.",
      intake: INTAKE,
    });
    expect(doc.pages.map((p) => p.id)).toEqual(["home", "products", "contact"]);
    expect(doc.pages[0].puck.content[0].type).toBe("HeroBanner");
    const contact = doc.pages.find((p) => p.id === "contact")!;
    expect(contact.puck.content.some((b) => b.type === "InquiryForm")).toBe(
      true,
    );
    const pageIds = new Set(doc.pages.map((p) => p.id));
    for (const n of doc.site.nav) expect(pageIds.has(n.pageId)).toBe(true);
  });

  it("文案只用注册事实：公司名/产品/目标市场入 bundle，不虚构年限或认证", () => {
    const doc = buildDemoSpec({
      siteName: "Acme Pump Co., Ltd.",
      intake: INTAKE,
    });
    const en = doc.copyBundles.en;
    const all = Object.values(en).join(" ");
    expect(all).toContain("Acme Pump Co., Ltd.");
    expect(all.toLowerCase()).toContain("centrifugal pump");
    expect(all).toContain("Germany");
    expect(all).toContain("United States");
    // 零虚构红线：demo 不得声称年限/认证/工厂面积（intake 没有这些事实）
    expect(all).not.toMatch(/\d+\s*(\+\s*)?years/i);
    expect(all).not.toMatch(/ISO\s*9001|CE certified/i);
  });

  it("textKey 完整性：spec 引用的所有 key（含组件内建 key）在 bundle 中存在", () => {
    const doc = buildDemoSpec({
      siteName: "Acme Pump Co., Ltd.",
      intake: INTAKE,
    });
    const keys = collectTextKeys(doc);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(doc.copyBundles.en[key], `missing copy for ${key}`).toBeTruthy();
    }
  });

  it("preset 选择：泵类默认 modern-industrial；医疗/电子类词 → precision-light；显式 stylePreset 优先", () => {
    expect(pickPreset(INTAKE)).toBe("modern-industrial");
    expect(
      pickPreset({
        ...INTAKE,
        products: ["ultrasound probe", "medical device housing"],
      }),
    ).toBe("precision-light");
    const doc = buildDemoSpec({
      siteName: "X",
      intake: INTAKE,
      stylePreset: "precision-light",
    });
    expect(doc.site.theme.preset).toBe("precision-light");
  });

  it("sanitizePolish：虚构指征（年限/认证/产能）命中即弃字段，干净文案放行", () => {
    expect(
      sanitizePolish({
        headline: "Reliable Pumps for Global Buyers",
        subhead: "With 20+ years of experience and ISO 9001 certification.",
        aboutBody: "A CE certified factory of 15,000 sqm with 300 workers.",
      }),
    ).toEqual({ headline: "Reliable Pumps for Global Buyers" });
    expect(sanitizePolish(undefined)).toEqual({});
    expect(
      sanitizePolish({ headline: "   ", subhead: "x".repeat(501) }),
    ).toEqual({});
  });

  it("R0-3（ADR-017）sanitizePolish：角色虚构（manufacturer/engineering team/quality control/export packaging）也剔除——堵住润色回灌身份", () => {
    expect(
      sanitizePolish({ headline: "Your Trusted Pump Manufacturer" }),
    ).toEqual({});
    expect(
      sanitizePolish({
        subhead: "Backed by our engineering team and quality control.",
      }),
    ).toEqual({});
    expect(
      sanitizePolish({ aboutBody: "Export packaging handled in-house." }),
    ).toEqual({});
    // 中性文案照常放行
    expect(
      sanitizePolish({ headline: "Reliable Pumps for Global Buyers" }),
    ).toEqual({
      headline: "Reliable Pumps for Global Buyers",
    });
  });

  it("R0-3（ADR-017）去虚构身份：非制造业 intake 不得默认写 manufacturer/engineering team/quality control/export packaging", () => {
    // 贸易/服务类：intake 无任何"制造商"事实，demo 绝不替其编造制造业身份（缺=中性，不虚构）
    const nonManufacturer: IntakeInput = {
      company: { nameZh: "示例国际贸易", nameEn: "Example Trading Co." },
      industry: "isic-4690",
      products: ["sourcing service", "logistics coordination"],
      targetMarkets: ["US"],
      hasWebsite: false,
      websiteUrl: null,
      businessEmail: "hello@example.com",
    };
    const doc = buildDemoSpec({
      siteName: "Example Trading Co.",
      intake: nonManufacturer,
    });
    const all = Object.values(doc.copyBundles.en).join(" ");
    // 守卫独立声明红线词表（不镜像实现，防实现被悄悄放宽 → 永久 CI 门）
    for (const forbidden of [
      /manufactur/i,
      /engineering team/i,
      /quality control/i,
      /export packaging/i,
    ]) {
      expect(all, `demo 文案不得含虚构身份 ${forbidden}`).not.toMatch(
        forbidden,
      );
    }
    // 仍必须用上真实 intake 事实（去虚构 ≠ 去内容）
    expect(all).toContain("Example Trading Co.");
    expect(all.toLowerCase()).toContain("sourcing service");
    expect(all).toContain("United States");
  });

  it("polish 覆盖 hero/about 文案；缺省用确定性模板", () => {
    const plain = buildDemoSpec({ siteName: "Acme", intake: INTAKE });
    const polished = buildDemoSpec({
      siteName: "Acme",
      intake: INTAKE,
      polish: { headline: "Reliable Pumps, Proven Worldwide" },
    });
    expect(polished.copyBundles.en["home.hero.headline"]).toBe(
      "Reliable Pumps, Proven Worldwide",
    );
    expect(plain.copyBundles.en["home.hero.headline"]).toContain("Acme");
    expect(polished.copyBundles.en["about.body"]).toBe(
      plain.copyBundles.en["about.body"],
    );
  });

  it("最长合法 intake 与过长 polish 仍产出符合已晋级组件预算的 demo", () => {
    const doc = buildDemoSpec({
      siteName: "A".repeat(200),
      intake: {
        ...INTAKE,
        company: { nameZh: "长名称", nameEn: "A".repeat(200) },
        products: ["B".repeat(120)],
      },
      polish: {
        headline: "polished ".repeat(20).trim(),
        subhead: "subhead ".repeat(30).trim(),
      },
    });
    const en = doc.copyBundles.en;
    const headline = en["home.hero.headline"];
    const subhead = en["home.hero.subhead"];
    expect(headline.length).toBeLessThanOrEqual(
      QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.headline,
    );
    expect(subhead.length).toBeLessThanOrEqual(
      QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.subhead,
    );
    expect(headline).not.toContain("polished");
    expect(subhead).not.toContain("subhead");
    expect(() =>
      assertQualifiedComponentContentBudget("HeroBanner", {
        headline,
        subhead,
        cta: en["home.hero.cta"],
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("CtaBanner", {
        headline: en["cta.headline"],
        cta: en["cta.label"],
      }),
    ).not.toThrow();
  });
});
