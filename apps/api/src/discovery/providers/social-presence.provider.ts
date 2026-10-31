import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
  ProviderContactRecord,
} from '../provider-contract';
import { MAX_CONTACTS_PER_DISCOVERY_ADAPTER } from '../execution-envelope';

/**
 * 社媒/渠道联系人适配器（M2a：搜索索引层）。
 *
 * 只经自托管 SearXNG 读**搜索引擎已索引的公开片段**（标题 + URL），不登录、不抓目标站页面、
 * 不逆向任何平台 API。LinkedIn `/in/*` 与 Xing `/profile/*` 的标题形如
 * 「Max Mustermann – Einkaufsleiter – Muster GmbH | LinkedIn」，从中解析姓名与职务。
 * 后续 M2b 的档案副本/公开页直抓会以独立能力加入（见设计稿 §5.3b）。
 */

export type SearxResultLike = { url: string; title?: string };

export const SOCIAL_PERSON_HOSTS: readonly { host: string; pathPrefix: string }[] = Object.freeze([
  { host: 'linkedin.com', pathPrefix: '/in/' },
  { host: 'xing.com', pathPrefix: '/profile/' },
]);

/** 社媒 dork：公司名 + 目标角色（LinkedIn / Xing），有域名时补一条域名锚定。 */
export function buildSocialDorks(
  company: { name: string; domain?: string },
  roles: readonly string[],
): string[] {
  const name = company.name.trim().replace(/"/g, '');
  if (!name) return [];
  const roleHint = roles
    .map((role) => role.trim().replace(/"/g, ''))
    .filter((role) => role.length > 0)
    .slice(0, 3)
    .map((role) => `"${role}"`)
    .join(' OR ');
  const queries = [
    `site:linkedin.com/in "${name}"`,
    `site:xing.com/profile "${name}"`,
    `site:linkedin.com/in "${name}" ${roleHint}`.trim(),
  ];
  if (company.domain) {
    queries.push(`site:linkedin.com/in "${company.name.trim()}" "${company.domain}"`);
  }
  return [...new Set(queries)].slice(0, 4);
}

const HEADLINE_SEGMENT = /\s*[|·]\s*|\s+[–—-]\s+/;

/** 解析社媒标题：「姓名 – 职务 – 公司 | 平台」；返回姓名与职务片段。 */
export function parseSocialHeadline(title: string): { fullName: string; title?: string } | null {
  const segments = title
    .split(HEADLINE_SEGMENT)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !/^(linkedin|xing)$/i.test(segment));
  if (!segments.length) return null;
  const fullName = segments[0]!;
  const words = fullName.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return null;
  const role = segments.length > 1 ? segments[1] : undefined;
  return { fullName, ...(role ? { title: role } : {}) };
}

function matchesCompany(headline: string, company: { name: string; domain?: string }): boolean {
  const haystack = headline.toLowerCase();
  const tokens = company.name
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .filter((token) => token.length >= 3);
  if (tokens.some((token) => haystack.includes(token))) return true;
  if (company.domain) {
    const root = company.domain.toLowerCase().split('.')[0];
    if (root && root.length >= 3 && haystack.includes(root)) return true;
  }
  // 公司名全是短词（如 "AB"）时无从校验：宁缺勿错，丢弃。
  return false;
}

/** 只保留个人主页 URL，并从标题解析出人；公司不匹配的一律丢弃（防张冠李戴）。 */
export function parseSocialResults(
  results: readonly SearxResultLike[],
  company: { name: string; domain?: string },
): ProviderContactRecord[] {
  const found = new Map<string, ProviderContactRecord>();
  for (const result of results) {
    if (!result?.url) continue;
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      continue;
    }
    const spec = SOCIAL_PERSON_HOSTS.find(
      (candidate) =>
        (url.hostname === candidate.host || url.hostname.endsWith(`.${candidate.host}`)) &&
        url.pathname.startsWith(candidate.pathPrefix),
    );
    if (!spec) continue;
    const headline = (result.title ?? '').trim();
    if (!headline) continue;
    if (!matchesCompany(headline, company)) continue;
    const parsed = parseSocialHeadline(headline);
    if (!parsed) continue;
    const key = `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
    if (found.has(key)) continue;
    found.set(key, {
      externalId: key,
      fullName: parsed.fullName,
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(spec.host === 'linkedin.com' ? { linkedin: `https://${url.hostname}${url.pathname}` } : {}),
      personalData: true,
      sourcePage: `https://${url.hostname}${url.pathname}`,
      license: 'public-index',
    });
  }
  return [...found.values()];
}

export class SocialPresenceContactAdapter implements ContactDiscoveryAdapter {
  readonly key = 'social_presence';

  constructor(private readonly deps: { broker?: ExecutionBroker }) {}

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    if (!this.deps.broker) return { contacts: [], costCents: 0 };
    const queries = buildSocialDorks(company, sellerCtx?.targetRoles ?? []);
    const seen = new Map<string, ProviderContactRecord>();
    for (const q of queries) {
      if (seen.size >= MAX_CONTACTS_PER_DISCOVERY_ADAPTER) break;
      try {
        const output = await this.deps.broker.invoke<
          { q: string; pages?: number },
          { results: SearxResultLike[] }
        >('searxng.search', { q, pages: 1 }, {
          ...ctx,
          taskContractId: 'contact.find_decision_makers',
          purpose: ['discovery', 'enrichment'],
        } as unknown as ToolContext);
        for (const contact of parseSocialResults(output.data?.results ?? [], company)) {
          if (!seen.has(contact.externalId)) seen.set(contact.externalId, contact);
        }
      } catch {
        /* 单条 dork 失败不影响其余查询 */
      }
    }
    return {
      contacts: [...seen.values()].slice(0, MAX_CONTACTS_PER_DISCOVERY_ADAPTER),
      costCents: 0,
    };
  }
}
