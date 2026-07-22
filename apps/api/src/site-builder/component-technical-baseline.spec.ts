import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { validateBlock } from "@global/contracts";

const { assertQualifiedComponentContentBudget } = createRequire(
  import.meta.url,
)("@global/contracts") as {
  assertQualifiedComponentContentBudget: (
    type: string,
    content: unknown,
  ) => void;
};

describe("M1-e-A technical baseline component contract", () => {
  it.each([
    ["LogoMarquee", { eyebrowKey: "logos.eyebrow", titleKey: "logos.title", items: ["ISO", "CE"], variant: "technical-grid" }],
    ["Testimonials", { eyebrowKey: "testimonials.eyebrow", items: [{ quoteKey: "quote", nameKey: "name", postcodeKey: "location", rating: 4.8, platformKey: "platform" }], variant: "technical-grid" }],
    ["FeatureCards", { eyebrowKey: "features.eyebrow", titleKey: "features.title", titleLine2Key: "features.titleLine2", introKey: "features.intro", items: [{ icon: "ri-settings-3-line", titleKey: "features.one.title", descKey: "features.one.desc" }, { icon: "ri-file-list-3-line", titleKey: "features.two.title", descKey: "features.two.desc" }], variant: "technical-grid" }],
    ["TechSystems", { chapterKey: "systems.chapter", titleKey: "systems.title", titleAccentKey: "systems.titleAccent", introKey: "systems.intro", systems: [{ label: "Hydraulic", titleKey: "systems.one.title", descKey: "systems.one.desc", metric: "16", suffix: "bar", metricLabelKey: "systems.one.metric" }, { label: "Materials", titleKey: "systems.two.title", descKey: "systems.two.desc", metric: "320", suffix: "°C", metricLabelKey: "systems.two.metric" }], variant: "technical-grid" }],
    ["MapLocation", { titleKey: "location.title", addressKey: "location.address", variant: "quiet" }],
    ["MapLocation", { titleKey: "location.title", addressKey: "location.address", variant: "static" }],
    ["ServicesGrid", { eyebrowKey: "services.eyebrow", titleKey: "services.title", titleAccentKey: "services.accent", introKey: "services.intro", services: [{ icon: "ri-settings-line", titleKey: "services.one.title", descKey: "services.one.description" }], variant: "technical-grid" }],
    ["TrustSplit", { eyebrowKey: "trust.eyebrow", titleKey: "trust.title", titleAccentKey: "trust.accent", introKey: "trust.intro", stats: [{ value: "24h", labelKey: "trust.one" }, { value: "ISO", labelKey: "trust.two" }], badges: [], portraitNameKey: "trust.name", portraitRoleKey: "trust.role", variant: "technical-grid" }],
    ["ProcessSteps", { eyebrowKey: "process.eyebrow", titleKey: "process.title", titleAccentKey: "process.accent", introKey: "process.intro", steps: [{ num: "01", icon: "ri-search-line", titleKey: "process.one.title", bodyKey: "process.one.body" }, { num: "02", icon: "ri-file-list-line", titleKey: "process.two.title", bodyKey: "process.two.body" }], variant: "technical-grid" }],
    ["ArticleGrid", { eyebrowKey: "articles.eyebrow", titleKey: "articles.title", titleLine2Key: "articles.line2", introKey: "articles.intro", items: [{ cat: "Guide", titleKey: "articles.one.title", descKey: "articles.one.description", readTime: "4 min" }], variant: "technical-grid" }],
    ["StatementBlock", { labelKey: "statement.label", statementKey: "statement.body", variant: "technical-grid" }],
    ["PricingTable", { eyebrowKey: "pricing.eyebrow", titleKey: "pricing.title", titleAccentKey: "pricing.accent", introKey: "pricing.intro", serviceColumnKey: "pricing.serviceColumn", fromColumnKey: "pricing.fromColumn", primaryCta: { labelKey: "pricing.contact", pageId: "contact" }, rows: [{ icon: "ri-settings-line", serviceKey: "pricing.service", noteKey: "pricing.note", fromKey: "pricing.from" }], footnoteKey: "pricing.footnote", variant: "technical-grid" }],
    ["StatsCountup", { headingKey: "stats.heading", stats: [{ value: 24, labelKey: "stats.hours" }, { value: 99, suffix: "%", labelKey: "stats.uptime" }], variant: "technical-grid" }],
    ["LedgerStats", { chapterKey: "ledger.chapter", titleKey: "ledger.title", bodyKey: "ledger.body", stats: [{ value: "24", labelKey: "ledger.hours" }, { value: "6", labelKey: "ledger.regions" }], clients: ["ISO 9001"], clientsLabelKey: "ledger.clients", variant: "technical-grid" }],
    ["PricingTiers", { eyebrowKey: "tiers.eyebrow", titleKey: "tiers.title", titleLine2Key: "tiers.line2", subKey: "tiers.sub", monthlyKey: "tiers.monthly", yearlyKey: "tiers.yearly", saveKey: "tiers.save", featuredKey: "tiers.featured", perMoKey: "tiers.perMonth", plans: [{ nameKey: "tiers.one.name", taglineKey: "tiers.one.tagline", monthly: 29, yearly: 290, featureKeys: ["tiers.one.feature"] }], variant: "technical-grid" }],
    ["ValueStrip", { headingKey: "value.heading", items: [{ icon: "ri-shield-check-line", labelKey: "value.quality" }, { icon: "ri-time-line", labelKey: "value.response" }], variant: "technical-grid" }],
  ])("%s accepts the technical-grid variant", (type, props) => {
    expect(() => validateBlock({ type, props } as never)).not.toThrow();
  });

  it("keeps the legacy PricingTiers CTA label input parseable without rendering a false action", () => {
    expect(() =>
      validateBlock({
        type: "PricingTiers",
        props: {
          eyebrowKey: "tiers.eyebrow",
          titleKey: "tiers.title",
          titleLine2Key: "tiers.line2",
          subKey: "tiers.sub",
          monthlyKey: "tiers.monthly",
          yearlyKey: "tiers.yearly",
          saveKey: "tiers.save",
          featuredKey: "tiers.featured",
          ctaPrefixKey: "tiers.legacyCta",
          perMoKey: "tiers.perMonth",
          plans: [{ nameKey: "tiers.one.name", taglineKey: "tiers.one.tagline", monthly: 29, yearly: 290, features: ["Legacy feature"] }],
          variant: "technical-grid",
        },
      } as never),
    ).not.toThrow();
  });

  it.each([
    ["LogoMarquee", { eyebrowKey: "logos.eyebrow", titleKey: "logos.title", items: ["ISO"], variant: "technical-grid" }],
    ["Testimonials", { eyebrowKey: "testimonials.eyebrow", items: [], variant: "technical-grid" }],
    ["FeatureCards", { eyebrowKey: "features.eyebrow", titleKey: "features.title", titleLine2Key: "features.titleLine2", introKey: "features.intro", items: [{ icon: "ri-settings-3-line", titleKey: "features.one.title", descKey: "features.one.desc" }], variant: "technical-grid" }],
    ["TechSystems", { chapterKey: "systems.chapter", titleKey: "systems.title", titleAccentKey: "systems.titleAccent", introKey: "systems.intro", systems: [{ label: "Hydraulic", titleKey: "systems.one.title", descKey: "systems.one.desc", metric: "16", suffix: "bar", metricLabelKey: "systems.one.metric" }], variant: "technical-grid" }],
    ["MapLocation", { titleKey: "location.title", addressKey: "location.address", variant: "interactive" }],
    ["MapLocation", { titleKey: "location.title", addressKey: "location.address", coords: { lat: 51.5, lng: -0.1 } }],
    ["ServicesGrid", { titleKey: "services.title", services: [] }],
    ["TrustSplit", { titleKey: "trust.title", stats: [{ value: "1", labelKey: "trust.one" }] }],
    ["ProcessSteps", { titleKey: "process.title", steps: [{ number: "01", titleKey: "process.one", bodyKey: "process.one.body" }] }],
    ["ArticleGrid", { titleKey: "articles.title", items: [] }],
    ["StatementBlock", { labelKey: "statement.label", statementKey: "statement.body", variant: "interactive" }],
    ["ServicesGrid", { eyebrowKey: "services.eyebrow", titleKey: "services.title", titleAccentKey: "services.accent", introKey: "services.intro", services: [{ icon: "ri-settings-line", titleKey: "services.one.title", descKey: "services.one.description" }], bookLabelKey: "cta.book", bookPageId: "book" }],
    ["TrustSplit", { eyebrowKey: "trust.eyebrow", titleKey: "trust.title", titleAccentKey: "trust.accent", introKey: "trust.intro", stats: [{ value: "24h", labelKey: "trust.one" }, { value: "ISO", labelKey: "trust.two" }], badges: [], portraitNameKey: "trust.name", portraitRoleKey: "trust.role", portraitPageId: "about" }],
    ["ArticleGrid", { eyebrowKey: "articles.eyebrow", titleKey: "articles.title", titleLine2Key: "articles.line2", introKey: "articles.intro", items: [{ cat: "Guide", titleKey: "articles.one.title", descKey: "articles.one.description", readTime: "4 min" }], readKey: "cta.read" }],
    ["PricingTable", { eyebrowKey: "pricing.eyebrow", titleKey: "pricing.title", titleAccentKey: "pricing.accent", introKey: "pricing.intro", serviceColumnKey: "pricing.serviceColumn", fromColumnKey: "pricing.fromColumn", primaryCta: { labelKey: "pricing.contact" }, rows: [{ icon: "ri-settings-line", serviceKey: "pricing.service", noteKey: "pricing.note", fromKey: "pricing.from" }], footnoteKey: "pricing.footnote" }],
    ["StatsCountup", { stats: [{ value: "24", labelKey: "stats.hours" }] }],
    ["LedgerStats", { chapterKey: "ledger.chapter", titleKey: "ledger.title", bodyKey: "ledger.body", stats: [{ value: "24", labelKey: "ledger.hours" }, { value: "6", labelKey: "ledger.regions" }], clients: [] }],
    ["PricingTiers", { eyebrowKey: "tiers.eyebrow", titleKey: "tiers.title", titleLine2Key: "tiers.line2", subKey: "tiers.sub", monthlyKey: "tiers.monthly", yearlyKey: "tiers.yearly", saveKey: "tiers.save", featuredKey: "tiers.featured", perMoKey: "tiers.perMonth", plans: [{ nameKey: "tiers.one.name", taglineKey: "tiers.one.tagline", monthly: 29, yearly: 290, features: [] }], ctaPrefixKey: "tiers.cta" }],
    ["ValueStrip", { headingKey: "value.heading", items: [{ icon: "ri-shield-check-line", labelKey: "value.quality" }], variant: "glass-orbit" }],
  ])("%s rejects props outside its qualified item cardinality", (type, props) => {
    expect(() => validateBlock({ type, props } as never)).toThrow(
      `INVALID_BLOCK_PROPS: ${type}`,
    );
  });

  it.each([
    ["ServicesGrid", { eyebrow: "Services", title: "Engineering support", accent: "that remains traceable", intro: "Scope, delivery and records stay clear.", cards: [{ title: "Duty review", description: "Operating conditions are documented.", icon: "ri-settings-line" }] }],
    ["TrustSplit", { eyebrow: "Trust", title: "Evidence", accent: "before claims", intro: "The working basis is visible.", metrics: [{ value: "24h", label: "Reply target" }, { value: "ISO", label: "Quality system" }], badges: ["CE"], name: "Technical team", role: "Project support" }],
    ["ProcessSteps", { eyebrow: "Process", title: "A clear", accent: "delivery sequence", intro: "Each stage remains reviewable.", items: [{ number: "01", icon: "ri-search-line", title: "Review", body: "Confirm the operating need." }, { number: "02", icon: "ri-file-list-line", title: "Document", body: "Record the agreed scope." }] }],
    ["ArticleGrid", { eyebrow: "Resources", title: "Useful", titleLine2: "technical notes", intro: "Material for practical decisions.", articles: [{ category: "Guide", title: "Selecting a duty point", description: "A short guide to operating data.", readTime: "4 min" }] }],
    ["StatementBlock", { label: "Our approach", statement: "Traceable information helps teams make the next decision." }],
    ["LogoMarquee", { eyebrow: "Verified capability", title: "Documentation that travels", items: ["ISO", "CE"] }],
    ["Testimonials", { eyebrow: "Project feedback", title: "Project feedback", items: [{ quote: "Documented and useful.", name: "Operations manager", location: "Northern Europe", platform: "Project review", rating: 4.8 }] }],
    ["FeatureCards", { eyebrow: "What the team receives", title: "Clear technical decisions", intro: "Focused information supports comparison.", items: [{ title: "Duty-point review", description: "Operating conditions are documented." }, { title: "Traceable documents", description: "Records are agreed against scope." }] }],
    ["TechSystems", { chapter: "Technical systems", title: "Built around operating duty", intro: "Relevant limits remain visible.", systems: [{ label: "Hydraulic", title: "Pressure-aware selection", description: "Duty data is reviewed.", metric: "16", suffix: "bar", metricLabel: "Reference pressure" }, { label: "Materials", title: "Material compatibility", description: "Choices reflect process media.", metric: "320", suffix: "°C", metricLabel: "Reference temperature" }] }],
    ["MapLocation", { title: "Engineering office", address: "Industrial Estate, Sheffield, United Kingdom" }],
    ["PricingTable", { eyebrow: "Pricing", title: "Commercial scope", accent: "made legible", intro: "Compare documented service options.", serviceColumn: "Service", fromColumn: "From", primaryCta: "Contact", footnote: "Scope is confirmed before release.", rows: [{ icon: "ri-settings-line", service: "Duty review", note: "Operating conditions are recorded.", from: "From €480" }] }],
    ["StatsCountup", { heading: "Key figures", stats: [{ value: "24", label: "Hour response" }, { value: "99%", label: "Documented scope" }] }],
    ["LedgerStats", { chapter: "Delivery ledger", title: "Traceable commercial work", body: "Each request has an accountable record.", stats: [{ value: "24", label: "Hour response" }, { value: "6", label: "Operating regions" }], clients: ["ISO 9001"], clientsLabel: "Working standards" }],
    ["PricingTiers", { eyebrow: "Pricing", title: "Choose a", titleLine2: "documented scope", sub: "Static pricing keeps comparison readable.", monthlyLabel: "Monthly", yearlyLabel: "Annual", save: "Save 15%", featured: "Most selected", perMo: "per month", plans: [{ name: "Review", tagline: "For an initial technical assessment.", monthly: "29", yearly: "290", featured: false, features: ["Duty-point review"] }] }],
    ["ValueStrip", { heading: "Values", items: [{ icon: "ri-shield-check-line", label: "Traceable scope" }, { icon: "ri-time-line", label: "Clear response target" }] }],
  ])("%s accepts bounded qualified content", (type, content) => {
    expect(() => assertQualifiedComponentContentBudget(type, content)).not.toThrow();
  });

  it.each([
    {
      type: "HeroBanner",
      props: {
        headlineKey: "hero.headline",
        variant: "technical-grid",
      },
    },
    {
      type: "StatsBand",
      props: {
        stats: [
          { value: "20+", labelKey: "stats.years" },
          { value: "40+", labelKey: "stats.markets" },
        ],
        variant: "technical-grid",
      },
    },
    {
      type: "CtaBanner",
      props: {
        headlineKey: "cta.headline",
        cta: { labelKey: "cta.label" },
        variant: "technical-grid",
      },
    },
    {
      type: "ProductGrid",
      props: {
        titleKey: "products.title",
        products: [{ nameKey: "products.p1" }],
        variant: "technical-grid",
      },
    },
    {
      type: "AboutBlock",
      props: {
        titleKey: "about.title",
        bodyKey: "about.body",
        variant: "technical-grid",
      },
    },
    {
      type: "InquiryForm",
      props: {
        titleKey: "inquiry.title",
        variant: "technical-grid",
      },
    },
    {
      type: "CertWall",
      props: {
        titleKey: "certs.title",
        certs: [{ labelKey: "certs.quality" }],
        variant: "technical-grid",
      },
    },
    {
      type: "ProcessTimeline",
      props: {
        titleKey: "process.title",
        steps: [
          { titleKey: "process.one", bodyKey: "process.one.body" },
          { titleKey: "process.two", bodyKey: "process.two.body" },
        ],
        variant: "technical-grid",
      },
    },
    {
      type: "FaqAccordion",
      props: {
        titleKey: "faq.title",
        items: [{ qKey: "faq.question", aKey: "faq.answer" }],
        variant: "technical-grid",
      },
    },
  ])("$type accepts the technical-grid variant", ({ type, props }) => {
    expect(() => validateBlock({ type, props } as never)).not.toThrow();
  });

  it.each([
    ["CertWall", { titleKey: "certs.title", certs: [] }],
    [
      "CertWall",
      {
        titleKey: "certs.title",
        certs: Array.from({ length: 9 }, () => ({ labelKey: "certs.quality" })),
      },
    ],
    [
      "ProcessTimeline",
      { titleKey: "process.title", steps: [{ titleKey: "one", bodyKey: "one.body" }] },
    ],
    [
      "ProcessTimeline",
      {
        titleKey: "process.title",
        steps: Array.from({ length: 7 }, (_, index) => ({
          titleKey: `step.${index}.title`,
          bodyKey: `step.${index}.body`,
        })),
      },
    ],
    ["FaqAccordion", { titleKey: "faq.title", items: [] }],
    [
      "FaqAccordion",
      {
        titleKey: "faq.title",
        items: Array.from({ length: 9 }, (_, index) => ({
          qKey: `faq.${index}.question`,
          aKey: `faq.${index}.answer`,
        })),
      },
    ],
  ])("%s rejects props outside its qualified item cardinality", (type, props) => {
    expect(() => validateBlock({ type, props } as never)).toThrow(
      `INVALID_BLOCK_PROPS: ${type}`,
    );
  });

  it.each([
    "HeroBanner",
    "StatsBand",
    "CtaBanner",
    "ProductGrid",
    "AboutBlock",
    "InquiryForm",
    "CertWall",
    "ProcessTimeline",
    "FaqAccordion",
  ])("%s rejects an unregistered decorative variant", (type) => {
    const props =
      type === "HeroBanner"
        ? { headlineKey: "hero.headline", variant: "glass-orbit" }
        : type === "StatsBand"
          ? {
              stats: [
                { value: "20+", labelKey: "stats.years" },
                { value: "40+", labelKey: "stats.markets" },
              ],
              variant: "glass-orbit",
            }
          : type === "ProductGrid"
            ? {
                titleKey: "products.title",
                products: [{ nameKey: "products.p1" }],
                variant: "glass-orbit",
              }
            : type === "AboutBlock"
              ? {
                  titleKey: "about.title",
                  bodyKey: "about.body",
                  variant: "glass-orbit",
                }
              : type === "InquiryForm"
                ? { titleKey: "inquiry.title", variant: "glass-orbit" }
                : type === "CertWall"
                  ? {
                      titleKey: "certs.title",
                      certs: [{ labelKey: "certs.quality" }],
                      variant: "glass-orbit",
                    }
                  : type === "ProcessTimeline"
                    ? {
                        titleKey: "process.title",
                        steps: [
                          { titleKey: "process.one", bodyKey: "process.one.body" },
                          { titleKey: "process.two", bodyKey: "process.two.body" },
                        ],
                        variant: "glass-orbit",
                      }
                    : type === "FaqAccordion"
                      ? {
                          titleKey: "faq.title",
                          items: [{ qKey: "faq.question", aKey: "faq.answer" }],
                          variant: "glass-orbit",
                        }
                : {
                    headlineKey: "cta.headline",
                    cta: { labelKey: "cta.label" },
                    variant: "glass-orbit",
                  };
    expect(() => validateBlock({ type, props } as never)).toThrow(
      `INVALID_BLOCK_PROPS: ${type}`,
    );
  });

  it("accepts content exactly at each component budget", () => {
    expect(() =>
      assertQualifiedComponentContentBudget("HeroBanner", {
        headline: "H".repeat(60),
        subhead: "S".repeat(140),
        cta: "C".repeat(24),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("StatsBand", {
        stats: Array.from({ length: 4 }, () => ({
          value: "V".repeat(8),
          label: "L".repeat(24),
        })),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("CtaBanner", {
        headline: "H".repeat(60),
        cta: "C".repeat(24),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("ProductGrid", {
        title: "T".repeat(60),
        products: [{ name: "N".repeat(48), blurb: "B".repeat(240) }],
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("AboutBlock", {
        title: "T".repeat(60),
        body: "B".repeat(400),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("InquiryForm", {
        title: "T".repeat(60),
        subhead: "S".repeat(140),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("CertWall", {
        title: "T".repeat(60),
        certs: Array.from({ length: 8 }, () => ({ label: "L".repeat(48) })),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("ProcessTimeline", {
        title: "T".repeat(60),
        steps: Array.from({ length: 6 }, () => ({
          title: "S".repeat(40),
          body: "B".repeat(160),
        })),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("FaqAccordion", {
        title: "T".repeat(60),
        items: Array.from({ length: 8 }, () => ({
          question: "Q".repeat(120),
          answer: "A".repeat(400),
        })),
      }),
    ).not.toThrow();
  });

  it.each([
    ["ServicesGrid", { eyebrow: "Services", title: "T".repeat(61), accent: "a", intro: "i", cards: [{ title: "t", description: "d" }] }],
    ["TrustSplit", { eyebrow: "Trust", title: "T", accent: "a", intro: "i", metrics: [{ value: "1", label: "one" }], badges: [], name: "Team", role: "Support" }],
    ["ProcessSteps", { eyebrow: "Process", title: "T", accent: "a", intro: "i", items: [{ number: "01", title: "One", body: "Body" }] }],
    ["ArticleGrid", { eyebrow: "Resources", title: "T", titleLine2: "L", intro: "i", articles: [{ category: "Guide", title: "T".repeat(81), description: "d", readTime: "4 min" }] }],
    ["StatementBlock", { label: "Label", statement: "S".repeat(241) }],
    ["HeroBanner", { headline: "H".repeat(61) }],
    [
      "HeroBanner",
      { headline: Array.from({ length: 9 }, () => "word").join(" ") },
    ],
    [
      "StatsBand",
      {
        stats: Array.from({ length: 5 }, () => ({
          value: "20+",
          label: "Markets",
        })),
      },
    ],
    [
      "StatsBand",
      {
        stats: [
          { value: "V".repeat(9), label: "Metric" },
          { value: "2", label: "Metric" },
        ],
      },
    ],
    ["CtaBanner", { headline: "H".repeat(61), cta: "Contact" }],
    [
      "CtaBanner",
      {
        headline: "Ready to discuss your project",
        cta: Array.from({ length: 5 }, () => "go").join(" "),
      },
    ],
    [
      "ProductGrid",
      { title: "Products", products: [{ name: "N".repeat(49) }] },
    ],
    ["AboutBlock", { title: "About", body: "B".repeat(401) }],
    ["InquiryForm", { title: "T".repeat(61) }],
    ["MapLocation", { title: "Office", address: "A".repeat(161) }],
    [
      "CertWall",
      { title: "Certifications", certs: Array.from({ length: 9 }, () => ({ label: "Record" })) },
    ],
    [
      "ProcessTimeline",
      { title: "Process", steps: [{ title: "One", body: "Body" }] },
    ],
    [
      "FaqAccordion",
      { title: "FAQ", items: [{ question: "Q", answer: "A".repeat(401) }] },
    ],
    ["PricingTable", { eyebrow: "Pricing", title: "Commercial scope", accent: "made legible", intro: "Compare documented service options.", serviceColumn: "Service", fromColumn: "From", primaryCta: "Contact", footnote: "F".repeat(161), rows: [{ icon: "ri-settings-line", service: "Duty review", note: "Operating conditions are recorded.", from: "From €480" }] }],
    ["StatsCountup", { heading: "Key figures", stats: [{ value: "24", label: "Hour response" }, { value: "99%", label: "L".repeat(49) }] }],
    ["LedgerStats", { chapter: "Delivery ledger", title: "Traceable commercial work", body: "Each request has an accountable record.", stats: [{ value: "24", label: "Hour response" }, { value: "6", label: "Operating regions" }], clients: [], clientsLabel: "Working standards" }],
    ["PricingTiers", { eyebrow: "Pricing", title: "Choose a", titleLine2: "documented scope", sub: "Static pricing keeps comparison readable.", monthlyLabel: "Monthly", yearlyLabel: "Annual", save: "Save 15%", featured: "Most selected", perMo: "per month", plans: [{ name: "Review", tagline: "For an initial technical assessment.", monthly: "29", yearly: "290", featured: false, features: [] }] }],
    ["ValueStrip", { heading: "Values", items: [{ icon: "ri-shield-check-line", label: "Traceable scope" }, { icon: "ri-time-line", label: "Clear response target" }, { icon: "ri-file-list-line", label: "L".repeat(81) }] }],
  ])("%s rejects copy beyond its content budget", (type, content) => {
    expect(() => assertQualifiedComponentContentBudget(type, content)).toThrow(
      `COMPONENT_CONTENT_BUDGET_EXCEEDED: ${type}`,
    );
  });
});
