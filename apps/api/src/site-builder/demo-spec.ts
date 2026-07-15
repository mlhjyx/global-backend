import type { IntakeInput } from './intake.service';

/**
 * demo v0 生成（02 §4 快速通道）：行业模板选择 + 注册 6 项确定性填充，
 * 可选 polish（一次轻文案调用的产物；超时/失败=不传，模板默认文案兜底）。
 * 🔴 零虚构红线（08 硬门）：文案只用 intake 事实（公司名/产品/目标市场），
 * 绝不编造年限/认证/产能——那些事实等向导资料进来后由 M1 管线补。
 */

export const DEMO_SPEC_VERSION = '1.0.0';

export interface DemoCopyPolish {
  headline?: string;
  subhead?: string;
  aboutBody?: string;
}

/** 模型输出里的虚构指征（Codex P2）：命中即弃该字段回退模板——宁可平淡不可造假。 */
const FABRICATION_PATTERNS: RegExp[] = [
  /\d+\s*\+?\s*(years?|年)/i, // 年限
  /\bISO\s*\d{3,5}\b/i, // 认证编号
  /\bCE\b/, // CE 标志
  /\bFDA\b/i,
  /\bUL\b/,
  /\d[\d,.]*\s*(m2|m²|sqm|square meters?|employees|workers|units\b)/i, // 面积/人数/产能
];
const POLISH_MAX_CHARS = 500;

/** 只放行"无法虚构事实"的润色文案；不合格字段静默回退确定性模板。 */
export function sanitizePolish(polish: DemoCopyPolish | undefined): DemoCopyPolish {
  if (!polish) return {};
  const out: DemoCopyPolish = {};
  for (const field of ['headline', 'subhead', 'aboutBody'] as const) {
    const value = polish[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > POLISH_MAX_CHARS) continue;
    if (FABRICATION_PATTERNS.some((re) => re.test(trimmed))) continue;
    out[field] = trimmed;
  }
  return out;
}

export interface DemoSpecInput {
  siteName: string;
  intake: IntakeInput;
  stylePreset?: string | null;
  polish?: DemoCopyPolish;
}

interface Block {
  type: string;
  props: Record<string, unknown>;
}

export interface MaterializedDemoDoc {
  specVersion: string;
  site: {
    defaultLocale: string;
    locales: string[];
    theme: { preset: string };
    nav: { labelKey: string; pageId: string }[];
    seoGlobal: { siteName: string };
  };
  pages: {
    id: string;
    path: string;
    puck: { content: Block[]; root: { props: Record<string, unknown> } };
    seo: { titleKey: string; descriptionKey: string };
  }[];
  assets: Record<string, never>;
  copyBundles: Record<string, Record<string, string>>;
}

const PRECISION_KEYWORDS =
  /electro|electronic|medical|device|instrument|precision|optic|sensor|diagnostic|ultrasound|pcb|semiconductor|pharma|lab/i;

/** 制造/工业类关键词（distill 自 trumpf+tecloman，目标客户=出海制造工厂）。 */
const MANUFACTURING_KEYWORDS =
  /manufact|machine|machiner|cnc|laser|metal|steel|industrial|factory|manufacturer|mechanical|mold|mould|cast|forg|fabricat|machining|tooling|pump|valve|bear|gear|motor|engine|weld|pipe|fitting/i;

/** 能源/储能子类（-> tecloman 风绿蓝；其余制造 -> trumpf 风企业蓝）。 */
const ENERGY_KEYWORDS =
  /energ|storage|batter|solar|wind|power|bess|photovoltaic|grid|renewable|inverter|charge|cell/i;

export function pickPreset(intake: IntakeInput): string {
  const haystack = [intake.industry, ...intake.products].join(' ');
  if (MANUFACTURING_KEYWORDS.test(haystack) || ENERGY_KEYWORDS.test(haystack)) {
    return ENERGY_KEYWORDS.test(haystack) ? 'industrial-tecloman' : 'industrial-trumpf';
  }
  return PRECISION_KEYWORDS.test(haystack) ? 'precision-light' : 'modern-industrial';
}

/** 模板选择：制造类 -> industrial 模板（B2B 工业骨架），其余 -> demo。 */
export function pickTemplate(intake: IntakeInput): 'demo' | 'industrial' {
  const haystack = [intake.industry, ...intake.products].join(' ');
  return MANUFACTURING_KEYWORDS.test(haystack) || ENERGY_KEYWORDS.test(haystack) ? 'industrial' : 'demo';
}

function titleCase(words: string): string {
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function regionName(alpha2: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(alpha2) ?? alpha2;
  } catch {
    return alpha2;
  }
}

export function buildDemoSpec(input: DemoSpecInput): MaterializedDemoDoc {
  const { siteName, intake, polish } = input;
  const preset = input.stylePreset ?? pickPreset(intake);
  const products = intake.products;
  const marketNames = intake.targetMarkets.map(regionName);
  const primaryProduct = titleCase(products[0] ?? 'products');

  const en: Record<string, string> = {
    'nav.home': 'Home',
    'nav.products': 'Products',
    'nav.contact': 'Contact',
    'footer.tagline': `${primaryProduct} manufacturer serving ${listJoin(marketNames)}.`,
    'seo.home.title': `${siteName} — ${primaryProduct} Manufacturer`,
    'seo.home.desc': `${siteName} manufactures ${listJoin(products)} for customers in ${listJoin(marketNames)}.`,
    'seo.products.title': `Products — ${siteName}`,
    'seo.products.desc': `Explore ${listJoin(products)} from ${siteName}.`,
    'seo.contact.title': `Contact — ${siteName}`,
    'seo.contact.desc': `Send an inquiry to ${siteName}.`,
    'home.hero.headline': polish?.headline ?? `${siteName} — Professional ${primaryProduct} Manufacturer`,
    'home.hero.subhead':
      polish?.subhead ??
      `We manufacture ${listJoin(products)} for customers in ${listJoin(marketNames)}.`,
    'home.hero.cta': 'Request a Quote',
    'products.title': 'Our Products',
    'about.title': `About ${siteName}`,
    'about.body':
      polish?.aboutBody ??
      `${siteName} is a manufacturer of ${listJoin(products)}, serving customers in ${listJoin(marketNames)}. Tell us about your requirements and our team will get back to you with specifications, samples and a tailored quotation.`,
    'process.title': 'How We Work',
    'process.s1.title': 'Requirement Review',
    'process.s1.body': 'Share your specifications and our engineering team confirms the details with you.',
    'process.s2.title': 'Production & Quality Control',
    'process.s2.body': 'Your order is manufactured and inspected against the agreed specification.',
    'process.s3.title': 'Delivery & Support',
    'process.s3.body': 'Export packaging, shipping documentation and responsive after-sales support.',
    'faq.title': 'Frequently Asked Questions',
    'faq.q1': 'Which markets do you serve?',
    'faq.a1': `We currently focus on customers in ${listJoin(marketNames)}.`,
    'faq.q2': 'How can I get a quotation?',
    'faq.a2': 'Send your requirements via the inquiry form and we will reply with details.',
    'cta.headline': 'Tell us about your project',
    'cta.label': 'Get in touch',
    'inquiry.title': 'Send an Inquiry',
    'inquiry.sub': 'We reply as soon as possible.',
    'inquiry.field.name': 'Your name',
    'inquiry.field.email': 'Work email',
    'inquiry.field.message': 'Tell us about your requirements',
    'inquiry.submit': 'Send inquiry',
    'inquiry.m0.note': 'The inquiry form goes live when your site is published.',
  };

  for (let i = 0; i < products.length; i += 1) {
    en[`products.p${i + 1}.name`] = titleCase(products[i]);
    en[`products.p${i + 1}.blurb`] =
      `Learn more about our ${products[i]} range — full specifications available on request.`;
  }

  const productCards = products.map((_, i) => ({
    nameKey: `products.p${i + 1}.name`,
    blurbKey: `products.p${i + 1}.blurb`,
  }));

  const productGrid = (n: number): Block => ({
    type: 'ProductGrid',
    props: { id: `ProductGrid-demo-${n}`, titleKey: 'products.title', products: productCards },
  });

  return {
    specVersion: DEMO_SPEC_VERSION,
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset },
      nav: [
        { labelKey: 'nav.home', pageId: 'home' },
        { labelKey: 'nav.products', pageId: 'products' },
        { labelKey: 'nav.contact', pageId: 'contact' },
      ],
      seoGlobal: { siteName },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        seo: { titleKey: 'seo.home.title', descriptionKey: 'seo.home.desc' },
        puck: {
          root: { props: {} },
          content: [
            {
              type: 'HeroBanner',
              props: {
                id: 'HeroBanner-demo-1',
                headlineKey: 'home.hero.headline',
                subheadKey: 'home.hero.subhead',
                cta: { labelKey: 'home.hero.cta', pageId: 'contact' },
              },
            },
            productGrid(1),
            {
              type: 'AboutBlock',
              props: { id: 'AboutBlock-demo-1', titleKey: 'about.title', bodyKey: 'about.body' },
            },
            {
              type: 'ProcessTimeline',
              props: {
                id: 'ProcessTimeline-demo-1',
                titleKey: 'process.title',
                steps: [
                  { titleKey: 'process.s1.title', bodyKey: 'process.s1.body' },
                  { titleKey: 'process.s2.title', bodyKey: 'process.s2.body' },
                  { titleKey: 'process.s3.title', bodyKey: 'process.s3.body' },
                ],
              },
            },
            {
              type: 'CtaBanner',
              props: {
                id: 'CtaBanner-demo-1',
                headlineKey: 'cta.headline',
                cta: { labelKey: 'cta.label', pageId: 'contact' },
              },
            },
          ],
        },
      },
      {
        id: 'products',
        path: '/products',
        seo: { titleKey: 'seo.products.title', descriptionKey: 'seo.products.desc' },
        puck: {
          root: { props: {} },
          content: [
            productGrid(2),
            {
              type: 'FaqAccordion',
              props: {
                id: 'FaqAccordion-demo-1',
                titleKey: 'faq.title',
                items: [
                  { qKey: 'faq.q1', aKey: 'faq.a1' },
                  { qKey: 'faq.q2', aKey: 'faq.a2' },
                ],
              },
            },
          ],
        },
      },
      {
        id: 'contact',
        path: '/contact',
        seo: { titleKey: 'seo.contact.title', descriptionKey: 'seo.contact.desc' },
        puck: {
          root: { props: {} },
          content: [
            {
              type: 'InquiryForm',
              props: { id: 'InquiryForm-demo-1', titleKey: 'inquiry.title', subKey: 'inquiry.sub' },
            },
          ],
        },
      },
    ],
    assets: {},
    copyBundles: { en },
  };
}

/**
 * B2B 工业/制造行业模板（distill 自 trumpf+tecloman；09 M1-e 模板生产）。
 * home: Hero -> StatsBand(工厂数字带) -> ProductGrid -> AboutBlock -> Process -> FAQ -> CTA
 * products: ProductGrid -> FAQ ; contact: InquiryForm
 * 🔴 零虚构红线（08 硬门）：StatsBand 只用 intake 可派生事实（产品线数/出口市场数）；
 *    真实工厂数字（面积/年限/产能）+ CertWall 认证 + MapLocation 地址由 brandProfile
 *    factSheet（M1-b 已落地）在 M1-e siteAssembly 阶段注入，此处不编造。
 *    FactoryShowcase/CaseStudies/NewsList 等缺口组件随 M1-e 扩库后插入（留位）。
 */
export function buildIndustrialSpec(input: DemoSpecInput): MaterializedDemoDoc {
  const { siteName, intake, polish } = input;
  const preset = input.stylePreset ?? pickPreset(intake);
  const products = intake.products;
  const marketNames = intake.targetMarkets.map(regionName);
  const primaryProduct = titleCase(products[0] ?? 'products');

  const en: Record<string, string> = {
    'nav.home': 'Home',
    'nav.products': 'Products',
    'nav.contact': 'Contact',
    'footer.tagline': `${primaryProduct} manufacturer. Engineered, exported, trusted worldwide.`,
    'seo.home.title': `${siteName} - ${primaryProduct} Manufacturer & Exporter`,
    'seo.home.desc': `${siteName} manufactures ${listJoin(products)} for industrial customers in ${listJoin(marketNames)}.`,
    'seo.products.title': `Products - ${siteName}`,
    'seo.products.desc': `Explore ${listJoin(products)} from ${siteName}.`,
    'seo.contact.title': `Contact - ${siteName}`,
    'seo.contact.desc': `Send an inquiry to ${siteName}.`,
    'home.hero.headline': polish?.headline ?? `${siteName} - Industrial ${primaryProduct} Manufacturing`,
    'home.hero.subhead':
      polish?.subhead ??
      `We engineer ${listJoin(products)} for industrial customers in ${listJoin(marketNames)}. Custom specifications, export-ready.`,
    'home.hero.cta': 'Request a Quote',
    'stats.products': 'Product Lines',
    'stats.markets': 'Export Markets',
    'products.title': 'Our Products',
    'factory.title': 'Our Factory',
    'cases.title': 'Customer Success Stories',
    'news.title': 'Newsroom',
    'trust.title': 'Trusted by',
    'testimonials.title': 'What Customers Say',
    'regions.title': 'Our Export Markets',
    'products.header.title': 'Products & Solutions',
    'products.header.sub': 'Explore our manufacturing capability.',
    'contact.header.title': 'Contact Us',
    'contact.header.sub': 'Send us your requirements and our team will reply with a tailored proposal.',
    'about.title': `About ${siteName}`,
    'about.body':
      polish?.aboutBody ??
      `${siteName} is an industrial manufacturer of ${listJoin(products)}, serving customers in ${listJoin(marketNames)}. Send us your specifications and our engineering team will respond with a tailored proposal, samples, and quotation.`,
    'process.title': 'How We Work',
    'process.s1.title': 'Engineering Review',
    'process.s1.body': 'Share your specifications; our engineers confirm feasibility and details.',
    'process.s2.title': 'Manufacturing & QC',
    'process.s2.body': 'Your order is manufactured and inspected against the agreed specification.',
    'process.s3.title': 'Export & Support',
    'process.s3.body': 'Export packaging, shipping documents, and responsive after-sales support.',
    'faq.title': 'Frequently Asked Questions',
    'faq.q1': 'Which markets do you serve?',
    'faq.a1': `We currently focus on customers in ${listJoin(marketNames)}.`,
    'faq.q2': 'How can I get a quotation?',
    'faq.a2': 'Send your requirements via the inquiry form and we will reply with details.',
    'cta.headline': 'Tell us about your project',
    'cta.label': 'Get in touch',
    'inquiry.title': 'Send an Inquiry',
    'inquiry.sub': 'We reply as soon as possible.',
    'inquiry.field.name': 'Your name',
    'inquiry.field.email': 'Work email',
    'inquiry.field.message': 'Tell us about your requirements',
    'inquiry.submit': 'Send inquiry',
    'inquiry.m0.note': 'The inquiry form goes live when your site is published.',
  };

  for (let i = 0; i < products.length; i += 1) {
    en[`products.p${i + 1}.name`] = titleCase(products[i]);
    en[`products.p${i + 1}.blurb`] = `Industrial ${products[i]} - specifications and datasheets available on request.`;
  }

  const productCards = products.map((_, i) => ({
    nameKey: `products.p${i + 1}.name`,
    blurbKey: `products.p${i + 1}.blurb`,
  }));

  const productGrid = (n: number): Block => ({
    type: 'ProductGrid',
    props: { id: `ProductGrid-ind-${n}`, titleKey: 'products.title', products: productCards },
  });

  // 出口市场（intake 派生，零虚构）-> RegionsGrid + region 名入 bundle
  const regions = intake.targetMarkets.map((m) => ({ code: m, nameKey: `region.${m}` }));
  for (const m of intake.targetMarkets) {
    en[`region.${m}`] = regionName(m);
  }

  return {
    specVersion: DEMO_SPEC_VERSION,
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset },
      nav: [
        { labelKey: 'nav.home', pageId: 'home' },
        { labelKey: 'nav.products', pageId: 'products' },
        { labelKey: 'nav.contact', pageId: 'contact' },
      ],
      seoGlobal: { siteName },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        seo: { titleKey: 'seo.home.title', descriptionKey: 'seo.home.desc' },
        puck: {
          root: { props: {} },
          content: [
            {
              type: 'HeroBanner',
              props: {
                id: 'HeroBanner-ind-1',
                headlineKey: 'home.hero.headline',
                subheadKey: 'home.hero.subhead',
                cta: { labelKey: 'home.hero.cta', pageId: 'contact' },
              },
            },
            {
              type: 'TrustBar',
              props: { id: 'TrustBar-ind-1', titleKey: 'trust.title', logos: [] },
            },
            {
              type: 'StatsBand',
              props: {
                id: 'StatsBand-ind-1',
                stats: [
                  { value: String(products.length || 1), labelKey: 'stats.products' },
                  { value: String(intake.targetMarkets.length || 1), labelKey: 'stats.markets' },
                ],
              },
            },
            productGrid(1),
            {
              type: 'FactoryShowcase',
              props: { id: 'FactoryShowcase-ind-1', titleKey: 'factory.title' },
            },
            {
              type: 'CaseStudies',
              props: { id: 'CaseStudies-ind-1', titleKey: 'cases.title', cases: [] },
            },
            {
              type: 'Testimonials',
              props: { id: 'Testimonials-ind-1', titleKey: 'testimonials.title', items: [] },
            },
            {
              type: 'AboutBlock',
              props: { id: 'AboutBlock-ind-1', titleKey: 'about.title', bodyKey: 'about.body' },
            },
            {
              type: 'ProcessTimeline',
              props: {
                id: 'ProcessTimeline-ind-1',
                titleKey: 'process.title',
                steps: [
                  { titleKey: 'process.s1.title', bodyKey: 'process.s1.body' },
                  { titleKey: 'process.s2.title', bodyKey: 'process.s2.body' },
                  { titleKey: 'process.s3.title', bodyKey: 'process.s3.body' },
                ],
              },
            },
            {
              type: 'RegionsGrid',
              props: { id: 'RegionsGrid-ind-1', titleKey: 'regions.title', regions },
            },
            {
              type: 'NewsList',
              props: { id: 'NewsList-ind-1', titleKey: 'news.title', items: [] },
            },
            {
              type: 'FaqAccordion',
              props: {
                id: 'FaqAccordion-ind-1',
                titleKey: 'faq.title',
                items: [
                  { qKey: 'faq.q1', aKey: 'faq.a1' },
                  { qKey: 'faq.q2', aKey: 'faq.a2' },
                ],
              },
            },
            {
              type: 'CtaBanner',
              props: {
                id: 'CtaBanner-ind-1',
                headlineKey: 'cta.headline',
                cta: { labelKey: 'cta.label', pageId: 'contact' },
              },
            },
          ],
        },
      },
      {
        id: 'products',
        path: '/products',
        seo: { titleKey: 'seo.products.title', descriptionKey: 'seo.products.desc' },
        puck: {
          root: { props: {} },
          content: [
            {
              type: 'PageHeader',
              props: {
                id: 'PageHeader-products',
                titleKey: 'products.header.title',
                subtitleKey: 'products.header.sub',
              },
            },
            productGrid(2),
            {
              type: 'FaqAccordion',
              props: {
                id: 'FaqAccordion-ind-2',
                titleKey: 'faq.title',
                items: [
                  { qKey: 'faq.q1', aKey: 'faq.a1' },
                  { qKey: 'faq.q2', aKey: 'faq.a2' },
                ],
              },
            },
          ],
        },
      },
      {
        id: 'contact',
        path: '/contact',
        seo: { titleKey: 'seo.contact.title', descriptionKey: 'seo.contact.desc' },
        puck: {
          root: { props: {} },
          content: [
            {
              type: 'PageHeader',
              props: {
                id: 'PageHeader-contact',
                titleKey: 'contact.header.title',
                subtitleKey: 'contact.header.sub',
              },
            },
            {
              type: 'InquiryForm',
              props: { id: 'InquiryForm-ind-1', titleKey: 'inquiry.title', subKey: 'inquiry.sub' },
            },
          ],
        },
      },
    ],
    assets: {},
    copyBundles: { en },
  };
}

/** 模板分发：制造类行业 -> industrial 模板，其余 -> demo。活动层统一调它。 */
export function buildSiteSpec(input: DemoSpecInput): MaterializedDemoDoc {
  return pickTemplate(input.intake) === 'industrial' ? buildIndustrialSpec(input) : buildDemoSpec(input);
}

/** InquiryForm 组件内建 key（渲染器直接 t() 这些 key，生成器必须供给）。 */
const INQUIRY_BUILTIN_KEYS = [
  'inquiry.field.name',
  'inquiry.field.email',
  'inquiry.field.message',
  'inquiry.submit',
  'inquiry.m0.note',
];

/** 收集 spec 引用的全部 textKey（含布局/组件内建），供完整性自检（04 §7 门 2 雏形）。 */
export function collectTextKeys(doc: MaterializedDemoDoc): string[] {
  const keys = new Set<string>(['footer.tagline']);
  for (const n of doc.site.nav) keys.add(n.labelKey);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.endsWith('Key') && typeof v === 'string') keys.add(v);
        else walk(v);
      }
    }
  };
  for (const page of doc.pages) {
    keys.add(page.seo.titleKey);
    keys.add(page.seo.descriptionKey);
    walk(page.puck.content);
    if (page.puck.content.some((b) => b.type === 'InquiryForm')) {
      for (const k of INQUIRY_BUILTIN_KEYS) keys.add(k);
    }
  }
  return [...keys];
}
