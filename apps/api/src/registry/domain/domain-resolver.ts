/**
 * 域名解析接口占位（ch03 §3.12 / T3-12 子集）。本波不接真实网络：
 * 三路 provider（search / ct / cc）只定义契约，用 fixture 实现做单测。
 *
 * 设计要点：
 *  - 候选只生成、不判定：VERIFIED 证据链（Impressum/VIES/评分）是后续 T3-13 的职责，
 *    这里产出的是「归一域名 + 来源路 + 排名」的候选池。
 *  - 单路 top-1 精度只有约 0.68（pipeworx 110 家标注集，厂商自报），所以 search 路
 *    取 top-N 全部域名，而不是 top-1。
 *  - CT（crt.sh 类）与 CC（Common Crawl）只作候选补充：CT 无 SLA、CC 对小微站点覆盖不足，
 *    都不能放关键路径唯一位置。
 *  - 域名归一复用 identity.normalizeDomain（去协议/www/路径），另剥离端口与尾点，
 *    拒绝 IP 与无点主机，过滤目录站/社交站噪声域（NOISE）。
 */
import { normalizeCompanyName, normalizeDomain } from '../../discovery/identity';

export type DomainRoute = 'source_field' | 'search' | 'ct_log' | 'cc_index' | 'manual';

export const DOMAIN_ROUTE_RANK: Record<DomainRoute, number> = {
  source_field: 0,
  manual: 0,
  search: 1,
  ct_log: 3,
  cc_index: 4,
};

export interface SearchHit {
  url: string;
  rank: number;
  title?: string;
}

export interface SearchQueryInput {
  q: string;
  count?: number;
  country?: string;
}

/** 搜索 provider 契约（Brave/Serper/Mojeek/SearXNG 共用；本波只有 fixture 实现）。 */
export interface DomainSearchProvider {
  readonly key: string;
  search(input: SearchQueryInput): Promise<SearchHit[]>;
}

/** 证书透明日志 provider 契约（crt.sh / CertStream）。返回匹配品牌 token 的域名。 */
export interface CertificateTransparencyProvider {
  readonly key: string;
  lookupDomainToken(token: string): Promise<string[]>;
}

/** Common Crawl URL Index provider 契约。返回匹配品牌 token 的 host 列表。 */
export interface CommonCrawlIndexProvider {
  readonly key: string;
  lookupHosts(input: { token: string; country?: string }): Promise<string[]>;
}

export interface DomainResolutionInput {
  name: string;
  country?: string | null;
  city?: string | null;
  /** 源自带 website（目录/展会/协会记录）；仍需后续证据校验。 */
  website?: string | null;
}

export interface DomainCandidate {
  domain: string;
  route: DomainRoute;
  routeRank: number;
  evidence: { provider?: string; alsoSeenIn?: string[] };
}

export type DomainResolutionStatus = 'CANDIDATES' | 'NOT_FOUND';

export interface DomainResolutionResult {
  candidates: DomainCandidate[];
  status: DomainResolutionStatus;
  notFoundReason?: 'NO_PROVIDERS' | 'NO_HITS';
}

export interface DomainResolver {
  resolve(input: DomainResolutionInput): Promise<DomainResolutionResult>;
}

/** 目录站/聚合页/社交站噪声域（v0 内置清单；后续与 public-web 的 NOISE_DOMAINS 合并）。 */
export const DEFAULT_NOISE_DOMAINS: readonly string[] = [
  'linkedin.com',
  'xing.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'youtube.com',
  'wikipedia.org',
  'wikidata.org',
  'bloomberg.com',
  'crunchbase.com',
  'northdata.de',
  'unternehmensregister.de',
  'handelsregister.de',
  'gelbeseiten.de',
  'yellowpages.com',
  'yelp.com',
  'indeed.com',
  'glassdoor.com',
  'google.com',
  'bing.com',
  'amazon.com',
  'ebay.com',
];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** URL 或裸 host → 规范域名（小写、去端口/尾点/www）；非法返回 null。 */
export function canonicalDomain(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/u, '');
  const domain = normalizeDomain(host);
  if (!domain || IPV4.test(domain) || domain.includes(':')) return null;
  if (!HOSTNAME.test(domain) || !/\.[a-z]{2,}$/u.test(domain)) return null;
  return domain;
}

function isNoise(domain: string, noise: ReadonlySet<string>): boolean {
  for (const entry of noise) {
    if (domain === entry || domain.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** 品牌 token：归一名称里最长的 ≥4 字符词（用于 CT/CC 查询）。 */
export function brandToken(name: string): string | null {
  const tokens = normalizeCompanyName(name)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return null;
  return tokens.reduce((best, token) => (token.length > best.length ? token : best), tokens[0]!);
}

export interface MultiRouteDomainResolverOptions {
  searchProviders?: DomainSearchProvider[];
  ctProviders?: CertificateTransparencyProvider[];
  ccProviders?: CommonCrawlIndexProvider[];
  noiseDomains?: readonly string[];
  maxCandidates?: number;
  /** 每个 search provider 的查询结果条数。 */
  searchCount?: number;
}

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_SEARCH_COUNT = 10;

export class MultiRouteDomainResolver implements DomainResolver {
  private readonly searchProviders: DomainSearchProvider[];
  private readonly ctProviders: CertificateTransparencyProvider[];
  private readonly ccProviders: CommonCrawlIndexProvider[];
  private readonly noise: ReadonlySet<string>;
  private readonly maxCandidates: number;
  private readonly searchCount: number;

  constructor(options: MultiRouteDomainResolverOptions = {}) {
    this.searchProviders = options.searchProviders ?? [];
    this.ctProviders = options.ctProviders ?? [];
    this.ccProviders = options.ccProviders ?? [];
    this.noise = new Set(options.noiseDomains ?? DEFAULT_NOISE_DOMAINS);
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.searchCount = options.searchCount ?? DEFAULT_SEARCH_COUNT;
  }

  async resolve(input: DomainResolutionInput): Promise<DomainResolutionResult> {
    const collected = new Map<string, DomainCandidate>();

    const offer = (raw: string, route: DomainRoute, provider?: string): void => {
      const domain = canonicalDomain(raw);
      if (!domain || isNoise(domain, this.noise)) return;
      const existing = collected.get(domain);
      if (existing) {
        if (provider && existing.evidence.provider !== provider) {
          const also = new Set(existing.evidence.alsoSeenIn ?? []);
          also.add(provider);
          existing.evidence.alsoSeenIn = [...also].sort();
        }
        return;
      }
      collected.set(domain, {
        domain,
        route,
        routeRank: DOMAIN_ROUTE_RANK[route],
        evidence: provider ? { provider } : {},
      });
    };

    if (input.website) offer(input.website, 'source_field');

    const token = brandToken(input.name);
    const query = `${input.name} ${input.city ?? input.country ?? ''}`.replace(/\s+/gu, ' ').trim();

    await Promise.all([
      ...this.searchProviders.map(async (provider) => {
        let hits: SearchHit[];
        try {
          hits = await provider.search({
            q: query,
            count: this.searchCount,
            country: input.country ?? undefined,
          });
        } catch {
          // 单路失败不影响其他路（候选生成本身可降级）。
          return;
        }
        for (const hit of [...hits].sort((a, b) => a.rank - b.rank)) {
          offer(hit.url, 'search', provider.key);
        }
      }),
      ...(token
        ? this.ctProviders.map(async (provider) => {
            let domains: string[];
            try {
              domains = await provider.lookupDomainToken(token);
            } catch {
              return;
            }
            for (const domain of domains) offer(domain, 'ct_log', provider.key);
          })
        : []),
      ...(token
        ? this.ccProviders.map(async (provider) => {
            let hosts: string[];
            try {
              hosts = await provider.lookupHosts({ token, country: input.country ?? undefined });
            } catch {
              return;
            }
            for (const host of hosts) offer(host, 'cc_index', provider.key);
          })
        : []),
    ]);

    const candidates = [...collected.values()]
      .sort((a, b) => {
        if (a.routeRank !== b.routeRank) return a.routeRank - b.routeRank;
        return a.domain.localeCompare(b.domain);
      })
      .slice(0, this.maxCandidates);

    if (candidates.length === 0) {
      const anyProvider =
        this.searchProviders.length + this.ctProviders.length + this.ccProviders.length > 0;
      return {
        candidates,
        status: 'NOT_FOUND',
        notFoundReason: anyProvider ? 'NO_HITS' : 'NO_PROVIDERS',
      };
    }
    return { candidates, status: 'CANDIDATES' };
  }
}
