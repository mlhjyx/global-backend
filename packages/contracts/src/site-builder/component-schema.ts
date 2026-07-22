/**
 * 运行时组件 props schema（zod，ADR-015 fail-closed 的 props 维）。
 * 每 type 一个 zod schema（必填 + 类型/结构 + 未知字段 .strict 拒绝 + variant 枚举）。
 * Renderer（Section 渲染前）+ Release（assertReleaseContract 晋级前）共用 validateBlock。
 * SiteSpec 是 JSON 不经 TypeScript，必须运行时校验：缺必填/错误类型/未知字段/未知 variant -> INVALID_BLOCK_PROPS throw。
 */
import { z } from "zod";
import {
  SITE_SPEC_COMPONENT_TYPES,
  type SiteSpecComponentType,
  type PuckBlock,
} from "./site-spec";

const str = z.string();
const strArr = z.array(z.string());
const strictObj = <T extends z.ZodRawShape>(fields: T) =>
  z.object(fields).strict();
const ctaSchema = strictObj({
  labelKey: str,
  pageId: str.optional(),
  url: str.optional(),
});
const releaseCtaSchema = strictObj({
  labelKey: str,
  pageId: str.min(1).optional(),
  url: str.min(1).optional(),
}).refine((cta) => Boolean(cta.pageId || cta.url));
const internalCtaSchema = strictObj({ labelKey: str, pageId: str.min(1) });
const statSchema = strictObj({ value: str, labelKey: str });
const statCountupSchema = strictObj({
  value: z.number(),
  suffix: str.optional(),
  labelKey: str,
});
const statSuffixSchema = strictObj({
  value: str,
  suffix: str.optional(),
  labelKey: str,
});
const technicalBaselineVariant = z.enum(["technical-grid", "quiet"]);

/** 每 type zod schema（.strict 拒绝未知字段；alt 由 Section 注入但 Props 声明，统一允许可选） */
const obj = (fields: Record<string, z.ZodTypeAny>) =>
  strictObj({
    ...fields,
    id: z.string().optional(),
    alt: z.boolean().optional(),
  });

export const COMPONENT_SCHEMAS = {
  HeroBanner: obj({
    headlineKey: str,
    subheadKey: str.optional(),
    cta: ctaSchema.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  StatsBand: obj({
    stats: z.array(statSchema).min(2).max(4),
    variant: technicalBaselineVariant.optional(),
  }),
  ProductGrid: obj({
    titleKey: str,
    products: z.array(
      strictObj({
        nameKey: str,
        blurbKey: str.optional(),
        image: strictObj({ assetId: str }).nullable().optional(),
      }),
    ),
    columns: z.number().int().min(2).max(4).optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  AboutBlock: obj({
    titleKey: str,
    bodyKey: str,
    foundedYear: z.number().nullable().optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  CertWall: obj({
    titleKey: str,
    certs: z
      .array(strictObj({ labelKey: str, assetId: str.optional() }))
      .min(1)
      .max(8),
    variant: technicalBaselineVariant.optional(),
  }),
  ProcessTimeline: obj({
    titleKey: str,
    steps: z.array(strictObj({ titleKey: str, bodyKey: str })).min(2).max(6),
    variant: technicalBaselineVariant.optional(),
  }),
  FaqAccordion: obj({
    titleKey: str,
    items: z.array(strictObj({ qKey: str, aKey: str })).min(1).max(8),
    variant: technicalBaselineVariant.optional(),
  }),
  CtaBanner: obj({
    headlineKey: str,
    cta: ctaSchema,
    variant: technicalBaselineVariant.optional(),
  }),
  InquiryForm: obj({
    titleKey: str,
    subKey: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  MapLocation: obj({
    titleKey: str,
    addressKey: str,
    // `static` is retained only for existing SiteSpec compatibility and is
    // normalized by the renderer to the technical-grid presentation. Maps,
    // embeds, geolocation and coordinates are deliberately outside Release.
    variant: z.enum(["technical-grid", "quiet", "static"]).optional(),
  }),
  HeroFull: obj({
    eyebrowKey: str,
    h1aKey: str,
    h1bKey: str,
    h1cKey: str,
    subKey: str,
    primaryCta: ctaSchema,
    ratingKey: str.optional(),
    secondaryCta: ctaSchema.optional(),
    selectors: z
      .array(
        strictObj({ icon: str, titleKey: str, subtitleKey: str, tagKey: str }),
      )
      .optional(),
    revealSuffixKey: str.optional(),
    revealCta: ctaSchema.optional(),
    image: strictObj({ assetId: str }).nullable().optional(),
  }),
  AreaMarquee: obj({
    headingKey: str.optional(),
    items: z.array(z.union([str, strictObj({ labelKey: str })])).min(2).max(12),
    variant: technicalBaselineVariant.optional(),
  }),
  ServicesGrid: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    services: z.array(
      strictObj({
        icon: str,
        titleKey: str,
        descKey: str,
        fromKey: str.optional(),
      }),
    ).min(1).max(8),
    allLabelKey: str.optional(),
    allPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  TrustSplit: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    stats: z.array(statSchema).min(2).max(4),
    badges: strArr,
    portraitNameKey: str,
    portraitRoleKey: str,
    variant: technicalBaselineVariant.optional(),
  }),
  ProcessSteps: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    steps: z.array(
      strictObj({
        num: z.union([str, z.number()]),
        icon: str,
        titleKey: str,
        bodyKey: str,
        metaKey: str.optional(),
      }),
    ).min(2).max(6),
    variant: technicalBaselineVariant.optional(),
  }),
  PricingTable: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    serviceColumnKey: str,
    fromColumnKey: str,
    primaryCta: internalCtaSchema,
    rows: z.array(
      strictObj({ icon: str, serviceKey: str, noteKey: str, fromKey: str }),
    ).min(1).max(8),
    footnoteKey: str,
    secondaryCta: internalCtaSchema.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  Testimonials: obj({
    eyebrowKey: str,
    titleKey: str.optional(),
    items: z.array(
      strictObj({
        quoteKey: str,
        nameKey: str,
        postcodeKey: str,
        rating: z.number(),
        platformKey: str,
      }),
    ).min(1).max(6),
    variant: technicalBaselineVariant.optional(),
  }),
  AreaGallery: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    areas: z.array(
      strictObj({
        name: str,
        postcodes: z.union([str, strArr]).optional(),
        noteKey: str,
        asset: strictObj({ assetId: str, altKey: str.optional() }).optional(),
      }),
    ).min(1).max(8),
    allLabelKey: str.optional(),
    allPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  FaqSplit: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    items: z.array(strictObj({ qKey: str, aKey: str })).min(1).max(8),
    variant: technicalBaselineVariant.optional(),
  }),
  CtaCenter: obj({
    eyebrowKey: str,
    titleKey: str,
    subtitleKey: str,
    primaryCta: releaseCtaSchema,
    titleAccentKey: str.optional(),
    secondaryCta: releaseCtaSchema.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  EditorialHero: obj({
    eyebrowKey: str,
    headlineKey: str,
    ctaLabelKey: str,
    statusKey: str,
    scrollKey: str,
    ctaPageId: str.optional(),
  }),
  ProjectsGrid: obj({
    titleKey: str,
    items: z.array(strictObj({ titleKey: str, descKey: str, asset: strictObj({ assetId: str, altKey: str.optional() }).optional() })).min(1).max(8),
    allLabelKey: str.optional(),
    allPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  ServicesDark: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    services: z.array(strictObj({ icon: str, titleKey: str, descKey: str })).min(1).max(8),
    allCta: internalCtaSchema.optional(),
    allLabelKey: str.optional(),
    allPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  StatsCountup: obj({ headingKey: str, stats: z.array(statCountupSchema).min(2).max(4), variant: technicalBaselineVariant.optional() }),
  MaterialsLibrary: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    items: z.array(
      strictObj({
        no: z.union([str, z.number()]),
        nameKey: str,
        weightKey: str,
        noteKey: str,
        asset: strictObj({ assetId: str, altKey: str.optional() }).optional(),
      }),
    ).min(1).max(8),
    ctaPrimaryLabelKey: str,
    ctaSecondaryLabelKey: str,
    ctaPrimaryPageId: str.optional(),
    ctaSecondaryPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  LogoMarquee: obj({
    eyebrowKey: str,
    titleKey: str,
    items: strArr.min(2).max(12),
    titleLine2Key: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  SplitAbout: obj({
    eyebrowKey: str,
    titleKey: str,
    bodyKey: str,
    ctaLabelKey: str,
    ctaPageId: str.optional(),
    chipIcon: str.optional(),
    chipKey: str.optional(),
  }),
  WarmHero: obj({
    eyebrowKey: str,
    h1Key: str,
    h1AccentKey: str,
    subKey: str,
    primaryCta: ctaSchema,
    stats: z.array(statSchema),
    scrollKey: str,
    secondaryCta: ctaSchema.optional(),
    primaryIcon: str.optional(),
  }),
  ServiceRows: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    services: z.array(
      strictObj({
        icon: str,
        titleKey: str,
        descKey: str,
        fromKey: str,
        unitKey: str,
      }),
    ).min(1).max(8),
    fromLabelKey: str.optional(),
    cta: internalCtaSchema.optional(),
    bookLabelKey: str.optional(),
    bookPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  DishesShowcase: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    dishes: z.array(strictObj({ nameKey: str, seasonKey: str, noteKey: str })),
    addLabelKey: str.optional(),
    addPageId: str.optional(),
  }),
  PhotoGallery: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    allLabelKey: str.optional(),
    allPageId: str.optional(),
    itemCount: z.number().optional(),
  }),
  MediaCta: obj({
    eyebrowKey: str,
    titleKey: str,
    titleAccentKey: str,
    subKey: str,
    primaryCta: ctaSchema,
    secondaryCta: ctaSchema.optional(),
    whatsappLabelKey: str.optional(),
    whatsappUrl: str.optional(),
    primaryIcon: str.optional(),
  }),
  FarmhouseHero: obj({
    eyebrowKey: str,
    h1Line1Key: str,
    h1Line2Key: str,
    primaryCta: ctaSchema,
    scrollKey: str,
    secondaryCta: ctaSchema.optional(),
  }),
  ValueStrip: obj({ headingKey: str, items: z.array(strictObj({ icon: str, labelKey: str })).min(2).max(6), variant: technicalBaselineVariant.optional() }),
  FeaturedSpotlight: obj({
    eyebrowKey: str,
    titleKey: str,
    items: z.array(
      strictObj({ nameKey: str, categoryKey: str, priceKey: str }),
    ),
    allLabelKey: str.optional(),
    allPageId: str.optional(),
  }),
  StoryChapters: obj({
    introEyebrowKey: str,
    introTitleKey: str,
    chapters: z.array(
      strictObj({
        eyebrowKey: str,
        titleKey: str,
        bodyKey: str,
        align: z.enum(["left", "right"]).optional(),
      }),
    ),
  }),
  CollectionCards: obj({
    eyebrowKey: str,
    titleKey: str,
    items: z.array(strictObj({ nameKey: str, asset: strictObj({ assetId: str, altKey: str.optional() }).optional() })).min(1).max(8),
    allPageId: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  DispatchHero: obj({
    fileKey: str,
    chapterKey: str,
    eyebrowKey: str,
    h1aKey: str,
    h1bKey: str,
    bodyKey: str,
    cta1Key: str,
    cta2Key: str,
    cta2PhoneKey: str,
    trustOpenKey: str,
    trustLicKey: str,
    coverageLabelKey: str,
    coverageValueKey: str,
    etaLabelKey: str,
    etaValueKey: str,
    marqueeItems: strArr,
  }),
  LedgerStats: obj({
    chapterKey: str,
    titleKey: str,
    bodyKey: str,
    stats: z.array(statSchema).min(2).max(4),
    clients: strArr.min(1).max(8),
    clientsLabelKey: str,
    variant: technicalBaselineVariant.optional(),
  }),
  ServicesEditorial: obj({
    chapterKey: str,
    services: z.array(
      strictObj({ code: str, titleKey: str, bodyKey: str, specKey: str }),
    ),
    notListKey: str.optional(),
    notListBodyKey: str.optional(),
    notListCtaKey: str.optional(),
    bookLabelKey: str.optional(),
  }),
  DispatchTimeline: obj({
    chapterKey: str,
    titleKey: str,
    titleAccentKey: str,
    bodyKey: str,
    ctaKey: str,
    callKey: str,
    callPhoneKey: str,
    steps: z.array(strictObj({ t: str, titleKey: str, bodyKey: str })),
  }),
  CrewGrid: obj({
    chapterKey: str,
    h1aKey: str,
    h1bKey: str,
    bodyKey: str,
    stats: z.array(strictObj({ labelKey: str, value: str, subKey: str })),
    members: z.array(
      strictObj({
        nameKey: str,
        roleKey: str,
        years: str,
        regionsKey: str,
        quoteKey: str,
        truckKey: str,
      }),
    ),
    footnoteKey: str,
    requestKey: str,
  }),
  CoverageMap: obj({
    chapterKey: str,
    titleKey: str,
    titleLine2Key: str,
    bodyKey: str,
    indexLabelKey: str,
    areas: z.array(strictObj({ name: str })),
    footnoteKey: str,
    pins: z.array(
      strictObj({
        labelKey: str,
        subKey: str,
        top: str,
        left: str,
        pulse: z.boolean().optional(),
      }),
    ),
    plateLabelKey: str,
    updatedKey: str,
  }),
  AxiomHero: obj({
    brandKey: str,
    brandSubKey: str,
    chapterKey: str,
    liveKey: str,
    h1aKey: str,
    h1bKey: str,
    h1cKey: str,
    serialKey: str,
    subKey: str,
    scrollKey: str,
  }),
  ChapterShowcase: obj({
    chapterKey: str,
    h1aKey: str,
    h1bKey: str,
    pieces: z.array(strictObj({ tagKey: str, nameKey: str, specKey: str })),
  }),
  ColorwayPicker: obj({
    chapterKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    items: z.array(
      strictObj({
        code: str,
        nameKey: str,
        subtitleKey: str,
        finishKey: str,
        hex: str,
        editionKey: str,
      }),
    ),
    reserveLabelKey: str.optional(),
    reservePageId: str.optional(),
  }),
  SaaSHero: obj({
    eyebrowKey: str,
    h1aKey: str,
    h1bKey: str,
    subKey: str,
    cta1Key: str,
    cta2Key: str,
    scrollKey: str,
  }),
  FeatureCards: obj({
    eyebrowKey: str,
    titleKey: str,
    titleLine2Key: str,
    introKey: str,
    items: z.array(strictObj({ icon: str, titleKey: str, descKey: str })).min(2).max(6),
    learnKey: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  PricingTiers: obj({
    eyebrowKey: str,
    titleKey: str,
    titleLine2Key: str,
    subKey: str,
    monthlyKey: str,
    yearlyKey: str,
    saveKey: str,
    featuredKey: str,
    // Legacy SiteSpec input is accepted but has no renderer behavior after A.7.
    ctaPrefixKey: str.optional(),
    perMoKey: str,
    plans: z.array(
      strictObj({
        nameKey: str,
        taglineKey: str,
        monthly: z.number(),
        yearly: z.number(),
        featured: z.boolean().optional(),
        featureKeys: strArr.min(1).max(8).optional(),
        // Preserve existing 1.0.0 documents while assemblers emit featureKeys.
        features: strArr.min(1).max(8).optional(),
      }).refine(
        (plan) => plan.featureKeys !== undefined || plan.features !== undefined,
        "Must provide featureKeys or legacy features",
      ),
    ).min(1).max(4),
    variant: technicalBaselineVariant.optional(),
  }),
  ArticleGrid: obj({
    eyebrowKey: str,
    titleKey: str,
    titleLine2Key: str,
    introKey: str,
    items: z.array(
      strictObj({ cat: str, titleKey: str, descKey: str, readTime: str }),
    ).min(1).max(8),
    variant: technicalBaselineVariant.optional(),
  }),
  IndustrialHero: obj({
    badgeKey: str,
    badgeSubKey: str,
    leftH1Key: str,
    leftH1AccentKey: str,
    leftSubKey: str,
    leftStats: z.array(statSuffixSchema),
    rightH1Key: str,
    rightH2aKey: str,
    rightH2bKey: str.optional(),
    rightH2bAccentKey: str,
    rightSubKey: str,
    cta1Key: str,
    cta2Key: str,
  }),
  ProductShowcaseAlt: obj({
    chapterKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    products: z.array(
      strictObj({
        code: str,
        nameKey: str,
        taglineKey: str,
        capacityKey: str,
        weightKey: str,
        cyclesKey: str,
        priceKey: str,
        asset: strictObj({ assetId: str, altKey: str.optional() }).optional(),
      }),
    ).min(1).max(6),
    configureKey: str.optional(),
    configurePageId: str.optional(),
    configureCta: internalCtaSchema.optional(),
    f1Key: str.optional(),
    f2Key: str.optional(),
    f3Key: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  TechSystems: obj({
    chapterKey: str,
    titleKey: str,
    titleAccentKey: str,
    introKey: str,
    systems: z.array(
      strictObj({
        label: str,
        titleKey: str,
        descKey: str,
        metric: str,
        suffix: str,
        metricLabelKey: str,
      }),
    ).min(2).max(6),
    liveKey: str.optional(),
    variant: technicalBaselineVariant.optional(),
  }),
  MinimalHero: obj({
    eyebrowKey: str,
    h1Key: str,
    h1AccentKey: str,
    subKey: str,
    cta1Key: str,
    cta2Key: str,
    scrollKey: str,
  }),
  StatementBlock: obj({ labelKey: str, statementKey: str, variant: technicalBaselineVariant.optional() }),
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
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`INVALID_BLOCK_PROPS: ${block.type} -- ${issues}`);
  }
}
