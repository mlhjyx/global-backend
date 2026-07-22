/**
 * 运行时组件 schema 校验（ADR-015 fail-closed 的 props 维）。
 *
 * SiteSpec 是 JSON（不经 TypeScript），`PuckBlock.type` 收紧为 `SiteSpecComponentType` 后，
 * 仍需运行时校验 props：每 type 的必填 *Key 存在且非空，未知 type/缺必填 fail-closed throw。
 * 结构数组内 *Key 由组件渲染时 `makeT` 校验（COPY_SLOT_MISSING）；variant/motion 枚举
 * 与未知字段拒绝策略属 M1-e-A 完整 zod schema，本文件先落必填 props 门。
 */
import {
  SITE_SPEC_COMPONENT_TYPES,
  type SiteSpecComponentType,
  type PuckBlock,
} from './site-spec';

/** 每 type 顶层必填 props（*Key 字符串，存在且非空）。结构数组内 *Key 由 makeT 校验。 */
export const COMPONENT_REQUIRED_KEYS: Record<SiteSpecComponentType, string[]> = {
  HeroBanner: ['headlineKey'],
  StatsBand: [],
  ProductGrid: ['titleKey'],
  AboutBlock: ['titleKey', 'bodyKey'],
  CertWall: ['titleKey'],
  ProcessTimeline: ['titleKey'],
  FaqAccordion: ['titleKey'],
  CtaBanner: ['headlineKey'],
  InquiryForm: ['titleKey'],
  MapLocation: ['titleKey', 'addressKey'],
  HeroFull: ['eyebrowKey', 'h1aKey', 'h1bKey', 'h1cKey', 'subKey', 'primaryCta'],
  AreaMarquee: [],
  ServicesGrid: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey'],
  TrustSplit: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey', 'portraitNameKey', 'portraitRoleKey'],
  ProcessSteps: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey'],
  PricingTable: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey', 'footnoteKey', 'primaryCta'],
  Testimonials: ['eyebrowKey'],
  AreaGallery: ['eyebrowKey', 'titleKey', 'titleAccentKey'],
  FaqSplit: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey'],
  CtaCenter: ['eyebrowKey', 'titleKey', 'subtitleKey', 'primaryCta'],
  EditorialHero: ['eyebrowKey', 'headlineKey', 'ctaLabelKey', 'statusKey', 'scrollKey'],
  ProjectsGrid: ['titleKey'],
  ServicesDark: ['eyebrowKey', 'titleKey', 'titleAccentKey'],
  StatsCountup: [],
  MaterialsLibrary: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey', 'ctaPrimaryLabelKey', 'ctaSecondaryLabelKey'],
  LogoMarquee: ['eyebrowKey', 'titleKey'],
  SplitAbout: ['eyebrowKey', 'titleKey', 'bodyKey', 'ctaLabelKey'],
  WarmHero: ['eyebrowKey', 'h1Key', 'h1AccentKey', 'subKey', 'scrollKey', 'primaryCta'],
  ServiceRows: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'introKey'],
  DishesShowcase: ['eyebrowKey', 'titleKey', 'titleAccentKey'],
  PhotoGallery: ['eyebrowKey', 'titleKey', 'titleAccentKey'],
  MediaCta: ['eyebrowKey', 'titleKey', 'titleAccentKey', 'subKey', 'primaryCta'],
  FarmhouseHero: ['eyebrowKey', 'h1Line1Key', 'h1Line2Key', 'scrollKey', 'primaryCta'],
  ValueStrip: [],
  FeaturedSpotlight: ['eyebrowKey', 'titleKey'],
  StoryChapters: ['introEyebrowKey', 'introTitleKey'],
  CollectionCards: ['eyebrowKey', 'titleKey'],
  DispatchHero: ['fileKey', 'chapterKey', 'eyebrowKey', 'h1aKey', 'h1bKey', 'bodyKey', 'cta1Key', 'cta2Key', 'cta2PhoneKey', 'trustOpenKey', 'trustLicKey', 'coverageLabelKey', 'coverageValueKey', 'etaLabelKey', 'etaValueKey'],
  LedgerStats: ['chapterKey', 'titleKey', 'bodyKey', 'clientsLabelKey'],
  ServicesEditorial: ['chapterKey'],
  DispatchTimeline: ['chapterKey', 'titleKey', 'titleAccentKey', 'bodyKey', 'ctaKey', 'callKey', 'callPhoneKey'],
  CrewGrid: ['chapterKey', 'h1aKey', 'h1bKey', 'bodyKey', 'footnoteKey', 'requestKey'],
  CoverageMap: ['chapterKey', 'titleKey', 'titleLine2Key', 'bodyKey', 'indexLabelKey', 'footnoteKey', 'plateLabelKey', 'updatedKey'],
  AxiomHero: ['brandKey', 'brandSubKey', 'chapterKey', 'liveKey', 'h1aKey', 'h1bKey', 'h1cKey', 'serialKey', 'subKey', 'scrollKey'],
  ChapterShowcase: ['chapterKey', 'h1aKey', 'h1bKey'],
  ColorwayPicker: ['chapterKey', 'titleKey', 'titleAccentKey', 'introKey'],
  SaaSHero: ['eyebrowKey', 'h1aKey', 'h1bKey', 'subKey', 'cta1Key', 'cta2Key', 'scrollKey'],
  FeatureCards: ['eyebrowKey', 'titleKey', 'titleLine2Key', 'introKey'],
  PricingTiers: ['eyebrowKey', 'titleKey', 'titleLine2Key', 'subKey', 'monthlyKey', 'yearlyKey', 'saveKey', 'featuredKey', 'ctaPrefixKey', 'perMoKey'],
  ArticleGrid: ['eyebrowKey', 'titleKey', 'titleLine2Key', 'introKey'],
  IndustrialHero: ['badgeKey', 'badgeSubKey', 'leftH1Key', 'leftH1AccentKey', 'leftSubKey', 'rightH1Key', 'rightH2aKey', 'rightH2bKey', 'rightH2bAccentKey', 'rightSubKey', 'cta1Key', 'cta2Key'],
  ProductShowcaseAlt: ['chapterKey', 'titleKey', 'titleAccentKey', 'introKey'],
  TechSystems: ['chapterKey', 'titleKey', 'titleAccentKey', 'introKey'],
  MinimalHero: ['eyebrowKey', 'h1Key', 'h1AccentKey', 'subKey', 'cta1Key', 'cta2Key', 'scrollKey'],
  StatementBlock: ['labelKey', 'statementKey'],
};

// 一致性：COMPONENT_REQUIRED_KEYS 的 keys 必须等于 SITE_SPEC_COMPONENT_TYPES（防漂移）
const _schemaKeys = Object.keys(COMPONENT_REQUIRED_KEYS) as SiteSpecComponentType[];
if (_schemaKeys.length !== SITE_SPEC_COMPONENT_TYPES.length) {
  throw new Error(
    `COMPONENT_REQUIRED_KEYS 数量(${_schemaKeys.length}) != SITE_SPEC_COMPONENT_TYPES(${SITE_SPEC_COMPONENT_TYPES.length})`,
  );
}
for (const k of _schemaKeys) {
  if (!SITE_SPEC_COMPONENT_TYPES.includes(k)) {
    throw new Error(`COMPONENT_REQUIRED_KEYS 含未知 type: ${k}`);
  }
}

/**
 * 运行时 block schema 校验：type 在封闭库（fail-closed）。
 * 必填 *Key 由组件渲染时 `makeT` 校验（缺 key -> COPY_SLOT_MISSING throw，fail-closed）；
 * 完整 zod schema（MISSING_REQUIRED_PROP + 封闭 variant/motion + 未知字段拒绝）属 M1-e-A。
 * 在 Section 渲染前 + release 指针晋级前执行。
 */
export function validateBlock(block: PuckBlock): void {
  if (!SITE_SPEC_COMPONENT_TYPES.includes(block.type)) {
    throw new Error(`UNKNOWN_COMPONENT_TYPE: ${block.type}`);
  }
}
