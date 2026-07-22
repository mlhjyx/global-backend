/**
 * 运行时组件 props schema（zod，ADR-015 fail-closed 的 props 维）。
 * 每 type 一个 zod schema（必填 + 类型/结构 + 未知字段 .strict 拒绝 + variant 枚举）。
 * Renderer（Section 渲染前）+ Release（assertReleaseContract 晋级前）共用 validateBlock。
 * SiteSpec 是 JSON 不经 TypeScript，必须运行时校验：缺必填/错误类型/未知字段/未知 variant -> INVALID_BLOCK_PROPS throw。
 */
import { z } from 'zod';
import { SITE_SPEC_COMPONENT_TYPES, type SiteSpecComponentType, type PuckBlock } from './site-spec';

const str = z.string();
const strArr = z.array(z.string());
const ctaSchema = z.object({ labelKey: str, pageId: str.optional(), url: str.optional() });
const statSchema = z.object({ value: str, labelKey: str });
const statCountupSchema = z.object({ value: z.number(), suffix: str.optional(), labelKey: str });
const statSuffixSchema = z.object({ value: str, suffix: str.optional(), labelKey: str });

/** 每 type zod schema（.strict 拒绝未知字段；alt 由 Section 注入但 Props 声明，统一允许可选） */
const obj = (fields: Record<string, z.ZodTypeAny>) =>
  z.object({ ...fields, id: z.string().optional(), alt: z.boolean().optional() }).strict();

export const COMPONENT_SCHEMAS = {
  HeroBanner: obj({ headlineKey: str, subheadKey: str.optional(), cta: ctaSchema.optional(), variant: str.optional() }),
  StatsBand: obj({ stats: z.array(statSchema) }),
  ProductGrid: obj({ titleKey: str, products: z.array(z.object({ nameKey: str, blurbKey: str.optional(), image: z.object({ assetId: str }).nullable().optional() })), columns: z.number().optional() }),
  AboutBlock: obj({ titleKey: str, bodyKey: str, foundedYear: z.number().nullable().optional() }),
  CertWall: obj({ titleKey: str, certs: z.array(z.object({ labelKey: str, assetId: str.optional() })) }),
  ProcessTimeline: obj({ titleKey: str, steps: z.array(z.object({ titleKey: str, bodyKey: str })) }),
  FaqAccordion: obj({ titleKey: str, items: z.array(z.object({ qKey: str, aKey: str })) }),
  CtaBanner: obj({ headlineKey: str, cta: ctaSchema }),
  InquiryForm: obj({ titleKey: str, subKey: str.optional() }),
  MapLocation: obj({ titleKey: str, addressKey: str, variant: z.enum(['static', 'interactive']).optional(), coords: z.object({ lat: z.number(), lng: z.number() }).nullable().optional() }),
  HeroFull: obj({ eyebrowKey: str, h1aKey: str, h1bKey: str, h1cKey: str, subKey: str, primaryCta: ctaSchema, ratingKey: str.optional(), secondaryCta: ctaSchema.optional(), selectors: z.array(z.object({ icon: str, titleKey: str, subtitleKey: str, tagKey: str })).optional(), revealSuffixKey: str.optional(), revealCta: ctaSchema.optional(), image: z.object({ assetId: str }).nullable().optional() }),
  AreaMarquee: obj({ items: strArr }),
  ServicesGrid: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, services: z.array(z.object({ icon: str, titleKey: str, descKey: str, fromKey: str.optional() })), allLabelKey: str.optional(), allPageId: str.optional(), bookLabelKey: str.optional(), bookPageId: str.optional() }),
  TrustSplit: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, stats: z.array(statSchema), badges: strArr, portraitNameKey: str, portraitRoleKey: str, portraitPageId: str.optional() }),
  ProcessSteps: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, steps: z.array(z.object({ num: z.union([str, z.number()]), icon: str, titleKey: str, bodyKey: str, metaKey: str.optional() })) }),
  PricingTable: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, primaryCta: ctaSchema, rows: z.array(z.object({ icon: str, serviceKey: str, noteKey: str, fromKey: str })), footnoteKey: str, secondaryCta: ctaSchema.optional() }),
  Testimonials: obj({ eyebrowKey: str, items: z.array(z.object({ quoteKey: str, nameKey: str, postcodeKey: str, rating: z.number(), platformKey: str })) }),
  AreaGallery: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, areas: z.array(z.object({ name: str, postcodes: z.union([str, strArr]).optional(), noteKey: str })), allLabelKey: str.optional(), allPageId: str.optional() }),
  FaqSplit: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, items: z.array(z.object({ qKey: str, aKey: str })) }),
  CtaCenter: obj({ eyebrowKey: str, titleKey: str, subtitleKey: str, primaryCta: ctaSchema, titleAccentKey: str.optional(), secondaryCta: ctaSchema.optional() }),
  EditorialHero: obj({ eyebrowKey: str, headlineKey: str, ctaLabelKey: str, statusKey: str, scrollKey: str, ctaPageId: str.optional() }),
  ProjectsGrid: obj({ titleKey: str, items: z.array(z.object({ titleKey: str, descKey: str })), allLabelKey: str.optional(), allPageId: str.optional() }),
  ServicesDark: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, services: z.array(z.object({ icon: str, titleKey: str, descKey: str })), allLabelKey: str.optional(), allPageId: str.optional() }),
  StatsCountup: obj({ stats: z.array(statCountupSchema) }),
  MaterialsLibrary: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, items: z.array(z.object({ no: z.union([str, z.number()]), nameKey: str, weightKey: str, noteKey: str })), ctaPrimaryLabelKey: str, ctaSecondaryLabelKey: str, ctaPrimaryPageId: str.optional(), ctaSecondaryPageId: str.optional() }),
  LogoMarquee: obj({ eyebrowKey: str, titleKey: str, items: strArr, titleLine2Key: str.optional() }),
  SplitAbout: obj({ eyebrowKey: str, titleKey: str, bodyKey: str, ctaLabelKey: str, ctaPageId: str.optional(), chipIcon: str.optional(), chipKey: str.optional() }),
  WarmHero: obj({ eyebrowKey: str, h1Key: str, h1AccentKey: str, subKey: str, primaryCta: ctaSchema, stats: z.array(statSchema), scrollKey: str, secondaryCta: ctaSchema.optional(), primaryIcon: str.optional() }),
  ServiceRows: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, introKey: str, services: z.array(z.object({ icon: str, titleKey: str, descKey: str, fromKey: str, unitKey: str })), bookLabelKey: str.optional(), bookPageId: str.optional() }),
  DishesShowcase: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, dishes: z.array(z.object({ nameKey: str, seasonKey: str, noteKey: str })), addLabelKey: str.optional(), addPageId: str.optional() }),
  PhotoGallery: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, allLabelKey: str.optional(), allPageId: str.optional(), itemCount: z.number().optional() }),
  MediaCta: obj({ eyebrowKey: str, titleKey: str, titleAccentKey: str, subKey: str, primaryCta: ctaSchema, secondaryCta: ctaSchema.optional(), whatsappLabelKey: str.optional(), whatsappUrl: str.optional(), primaryIcon: str.optional() }),
  FarmhouseHero: obj({ eyebrowKey: str, h1Line1Key: str, h1Line2Key: str, primaryCta: ctaSchema, scrollKey: str, secondaryCta: ctaSchema.optional() }),
  ValueStrip: obj({ items: z.array(z.object({ icon: str, labelKey: str })) }),
  FeaturedSpotlight: obj({ eyebrowKey: str, titleKey: str, items: z.array(z.object({ nameKey: str, categoryKey: str, priceKey: str })), allLabelKey: str.optional(), allPageId: str.optional() }),
  StoryChapters: obj({ introEyebrowKey: str, introTitleKey: str, chapters: z.array(z.object({ eyebrowKey: str, titleKey: str, bodyKey: str, align: z.enum(['left', 'right']).optional() })) }),
  CollectionCards: obj({ eyebrowKey: str, titleKey: str, items: z.array(z.object({ nameKey: str })), allPageId: str.optional() }),
  DispatchHero: obj({ fileKey: str, chapterKey: str, eyebrowKey: str, h1aKey: str, h1bKey: str, bodyKey: str, cta1Key: str, cta2Key: str, cta2PhoneKey: str, trustOpenKey: str, trustLicKey: str, coverageLabelKey: str, coverageValueKey: str, etaLabelKey: str, etaValueKey: str, marqueeItems: strArr }),
  LedgerStats: obj({ chapterKey: str, titleKey: str, bodyKey: str, stats: z.array(statSchema), clients: strArr, clientsLabelKey: str }),
  ServicesEditorial: obj({ chapterKey: str, services: z.array(z.object({ code: str, titleKey: str, bodyKey: str, specKey: str })), notListKey: str.optional(), notListBodyKey: str.optional(), notListCtaKey: str.optional(), bookLabelKey: str.optional() }),
  DispatchTimeline: obj({ chapterKey: str, titleKey: str, titleAccentKey: str, bodyKey: str, ctaKey: str, callKey: str, callPhoneKey: str, steps: z.array(z.object({ t: str, titleKey: str, bodyKey: str })) }),
  CrewGrid: obj({ chapterKey: str, h1aKey: str, h1bKey: str, bodyKey: str, stats: z.array(z.object({ labelKey: str, value: str, subKey: str })), members: z.array(z.object({ nameKey: str, roleKey: str, years: str, regionsKey: str, quoteKey: str, truckKey: str })), footnoteKey: str, requestKey: str }),
  CoverageMap: obj({ chapterKey: str, titleKey: str, titleLine2Key: str, bodyKey: str, indexLabelKey: str, areas: z.array(z.object({ name: str })), footnoteKey: str, pins: z.array(z.object({ labelKey: str, subKey: str, top: str, left: str, pulse: z.boolean().optional() })), plateLabelKey: str, updatedKey: str }),
  AxiomHero: obj({ brandKey: str, brandSubKey: str, chapterKey: str, liveKey: str, h1aKey: str, h1bKey: str, h1cKey: str, serialKey: str, subKey: str, scrollKey: str }),
  ChapterShowcase: obj({ chapterKey: str, h1aKey: str, h1bKey: str, pieces: z.array(z.object({ tagKey: str, nameKey: str, specKey: str })) }),
  ColorwayPicker: obj({ chapterKey: str, titleKey: str, titleAccentKey: str, introKey: str, items: z.array(z.object({ code: str, nameKey: str, subtitleKey: str, finishKey: str, hex: str, editionKey: str })), reserveLabelKey: str.optional(), reservePageId: str.optional() }),
  SaaSHero: obj({ eyebrowKey: str, h1aKey: str, h1bKey: str, subKey: str, cta1Key: str, cta2Key: str, scrollKey: str }),
  FeatureCards: obj({ eyebrowKey: str, titleKey: str, titleLine2Key: str, introKey: str, items: z.array(z.object({ icon: str, titleKey: str, descKey: str })), learnKey: str.optional() }),
  PricingTiers: obj({ eyebrowKey: str, titleKey: str, titleLine2Key: str, subKey: str, monthlyKey: str, yearlyKey: str, saveKey: str, featuredKey: str, ctaPrefixKey: str, perMoKey: str, plans: z.array(z.object({ nameKey: str, taglineKey: str, monthly: z.number(), yearly: z.number(), featured: z.boolean().optional(), features: strArr })) }),
  ArticleGrid: obj({ eyebrowKey: str, titleKey: str, titleLine2Key: str, introKey: str, items: z.array(z.object({ cat: str, titleKey: str, descKey: str, readTime: str })), readKey: str.optional() }),
  IndustrialHero: obj({ badgeKey: str, badgeSubKey: str, leftH1Key: str, leftH1AccentKey: str, leftSubKey: str, leftStats: z.array(statSuffixSchema), rightH1Key: str, rightH2aKey: str, rightH2bKey: str.optional(), rightH2bAccentKey: str, rightSubKey: str, cta1Key: str, cta2Key: str }),
  ProductShowcaseAlt: obj({ chapterKey: str, titleKey: str, titleAccentKey: str, introKey: str, products: z.array(z.object({ code: str, nameKey: str, taglineKey: str, capacityKey: str, weightKey: str, cyclesKey: str, priceKey: str })), configureKey: str.optional(), f1Key: str.optional(), f2Key: str.optional(), f3Key: str.optional() }),
  TechSystems: obj({ chapterKey: str, titleKey: str, titleAccentKey: str, introKey: str, systems: z.array(z.object({ label: str, titleKey: str, descKey: str, metric: str, suffix: str, metricLabelKey: str })), liveKey: str.optional() }),
  MinimalHero: obj({ eyebrowKey: str, h1Key: str, h1AccentKey: str, subKey: str, cta1Key: str, cta2Key: str, scrollKey: str }),
  StatementBlock: obj({ labelKey: str, statementKey: str }),
} as const satisfies Record<SiteSpecComponentType, z.ZodObject<z.ZodRawShape>>;

// 一致性：COMPONENT_SCHEMAS keys 必须等于 SITE_SPEC_COMPONENT_TYPES（防漂移）
const _schemaKeys = Object.keys(COMPONENT_SCHEMAS) as SiteSpecComponentType[];
if (_schemaKeys.length !== SITE_SPEC_COMPONENT_TYPES.length) {
  throw new Error(
    `COMPONENT_SCHEMAS 数量(${_schemaKeys.length}) != SITE_SPEC_COMPONENT_TYPES(${SITE_SPEC_COMPONENT_TYPES.length})`,
  );
}
for (const k of _schemaKeys) {
  if (!SITE_SPEC_COMPONENT_TYPES.includes(k)) {
    throw new Error(`COMPONENT_SCHEMAS 含未知 type: ${k}`);
  }
}

/**
 * 运行时 block schema 校验：zod parse props（必填 + 类型/结构 + 未知字段 .strict 拒绝 + variant 枚举）。
 * 未知 type -> UNKNOWN_COMPONENT_TYPE；props 不合法 -> INVALID_BLOCK_PROPS（含缺必填/错误类型/未知字段/未知 variant）。
 * Section 渲染前 + release 指针晋级前执行（fail-closed，不静默缺块/晋级）。
 */
export function validateBlock(block: PuckBlock): void {
  if (!SITE_SPEC_COMPONENT_TYPES.includes(block.type)) {
    throw new Error(`UNKNOWN_COMPONENT_TYPE: ${block.type}`);
  }
  const schema = COMPONENT_SCHEMAS[block.type];
  const result = schema.safeParse(block.props);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`INVALID_BLOCK_PROPS: ${block.type} -- ${issues}`);
  }
}
