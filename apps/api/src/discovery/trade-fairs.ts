import { AlgoliaFairConfig } from '../adapters/trade-fair-algolia';

/**
 * 展会参展商模板注册表（逐站/逐平台）。按 ICP 行业词选相关展会，拉其参展商名录。
 * 每个模板绑定一届展会的 Algolia 配置（public search-only key），换届需刷新（见
 * adapters/trade-fair-algolia.ts 顶注 + scripts/discover-fair-algolia.mjs）。
 */
export interface TradeFairTemplate {
  slug: string;
  name: string;
  platform: 'rx_algolia';
  /** 参展商目录页（provenance + 刷新配置的入口） */
  exhibitorUrl: string;
  algolia: AlgoliaFairConfig;
  /** 行业主题词（小写），用于按 ICP 行业/关键词选展会 */
  topics: string[];
  /** 展会举办地/覆盖区域（可选，用于地域偏好） */
  region?: string;
}

export const TRADE_FAIRS: TradeFairTemplate[] = [
  {
    slug: 'euroblech-2026',
    name: 'EuroBLECH 2026 (International Sheet Metal Working Technology Exhibition)',
    platform: 'rx_algolia',
    exhibitorUrl: 'https://www.euroblech.com/en-gb/exhibitor-directory.html',
    algolia: {
      appId: 'XD0U5M6Y4R',
      apiKey: 'd5cd7d4ec26134ff4a34d736a7f9ad47', // public search-only key（网站公开使用）
      indexName: 'evt-005dfa82-29a0-47d9-863a-38859f1e3e88-index',
      eventEditionId: 'eve-61ade742-93a7-4e7a-8022-cd407f60238d',
      locale: 'en-gb',
    },
    topics: [
      'sheet metal', 'sheet metal working', 'metalworking', 'metal fabrication',
      'laser cutting', 'laser', 'metal forming', 'forming', 'stamping', 'punching',
      'bending', 'press brake', 'welding', 'joining', 'tube', 'deburring',
      'cutting', 'machine tool', '钣金', '激光切割', '金属加工', '冲压', '折弯',
    ],
    region: 'Europe',
  },
];

/** 按 ICP 行业/关键词（+可选地域）选相关展会模板。命中 = 主题词出现在行业/关键词里。 */
export function selectFairs(params: {
  industryTerms?: string[];
  keywords?: string[];
  region?: string;
}): TradeFairTemplate[] {
  const hay = [...(params.industryTerms ?? []), ...(params.keywords ?? [])]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (!hay.length) return [];
  return TRADE_FAIRS.filter((fair) =>
    fair.topics.some((t) => hay.some((h) => h.includes(t) || t.includes(h))),
  );
}
