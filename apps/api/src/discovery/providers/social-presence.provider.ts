import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { isTerminalExternalActionPolicyDenied } from '../../tools/tool-contract';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
  ProviderContactRecord,
} from '../provider-contract';
import {
  MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
  MAX_SOCIAL_DORKS,
  MAX_SOCIAL_PROFILE_FETCHES,
} from '../execution-envelope';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import { normalizePersonName } from '../person-name';
import { cleanEmail, cleanPhone } from '../../acquisition/clean';
import {
  ExtractedPerson,
  extractPeopleFromPage,
} from './contact-extraction';

/**
 * 社媒/渠道联系人适配器（M2a 索引层 + M2b 档案/直抓层）。
 *
 * 三层降级（设计稿 §5.3b；D1 由产品负责人 2026-10-31 拍板，见
 * `docs/superpowers/plans/2026-10-31-contact-discovery.md`）：
 *  L1 档案副本 —— Wayback availability API 找快照，`http.get` 读 web.archive.org 副本
 *     （不触目标站；只认 3 年内、200 状态的快照，过旧档案只当不存在）；
 *  L2 公开页直抓 —— `social.fetch` 读无需登录的公开个人页。LinkedIn 是产品负责人显式
 *     接受的 robots 例外域：抓取失败或 999/403/登录墙即停，不重试、不换 IP；连续 3 次被拒
 *     熔断 30 分钟。Xing 公开页实测是 SPA 壳（可见文本仅 "XING"），直抓无收益，只走 L1。
 *     抓取不走 http.get/crawl4ai：它们的 subject-bound 工件契约要求 URL 无 query/纯小写/
 *     数字 <9 位，而 Wayback availability 与快照 URL 天生违反（2026-11-01 验收 run
 *     1c233bb6 因此 FAILED）；`social.fetch` 用 typed projection 持久化，且 broker 按域
 *     ≤1 req/3s（Redis limiter，跨进程）。
 *  L3 搜索索引 —— `social.search` 只读已索引标题（M2a；个人主页 URL/标题即具名人，
 *     searxng.search 会按 personalData:false 把它们全部过滤，故用独立工具）。
 *
 * 铁律：永不登录、不绕验证码、不逆向平台 API；抽到的人必须同时命中「候选姓名」与
 * 「公司名」，否则丢弃（防张冠李戴）。证据许可按层标注 public-index / public-archive /
 * public-page。节流由 broker 的 perDomainCrawlDelayMs=3000 跨进程执行；熔断是进程级
 * 状态（API 与 worker 各一份），最坏为 3×进程数 次拒绝后全开——有意的保守边界。
 */

export type SearxResultLike = { url: string; title?: string };

export const SOCIAL_PERSON_HOSTS: readonly { host: string; pathPrefix: string }[] = Object.freeze([
  { host: 'linkedin.com', pathPrefix: '/in/' },
  // LinkedIn 旧版 /pub/ 个人页：social.search 保留它们，解析层必须一致接纳。
  { host: 'linkedin.com', pathPrefix: '/pub/' },
  { host: 'xing.com', pathPrefix: '/profile/' },
]);

/** 快照新鲜度上限：Wayback 常返回多年前的档案，过旧的职务/联系方式不能当现值落库。 */
const SNAPSHOT_MAX_AGE_YEARS = 3;
/** 直抓页面的原始 HTML 先截断再清洗（http.get 工件上限 3MB，全文清洗浪费内存）。 */
const RAW_HTML_SLICE_CHARS = 300_000;

function rethrowIfTerminal(error: unknown): void {
  // 抑制门拒绝是终态（对外动作政策否决）；工件存储不可用是平台故障——两者上抛。
  // 其余 ToolPolicyDenied（域名 SUSPENDED、主体绑定、allowedTools）只跳过本候选，
  // 绝不让一个域的策略拒绝拖垮整家公司的联系人发现。⚠ isTerminalExternalActionPolicyDenied
  // 对**任何** ToolPolicyDenied 都返回 true（见 tool-contract.ts），必须按 reason 精确先行判定。
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'ToolPolicyDenied') {
    const reason = (error as { reason?: unknown }).reason;
    if (reason === 'suppression_action_gate' || reason === 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE') {
      throw error;
    }
    return;
  }
  if (isTerminalExternalActionPolicyDenied(error)) throw error;
  if (isExecutionControlError(error)) throw error;
}

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
  return [...new Set(queries)].slice(0, MAX_SOCIAL_DORKS);
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

/** 公司名比对里无区分度的法律形式/泛词（"GmbH" 不能证明页面属于这家公司）。 */
const LEGAL_FORM_TOKENS = new Set([
  'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'ek', 'inc', 'incorporated',
  'ltd', 'limited', 'llc', 'corp', 'corporation', 'co', 'company', 'plc',
  'sa', 'sas', 'sarl', 'bv', 'nv', 'holding', 'holdings', 'group', 'gruppe',
  'international', 'und', 'the', 'der', 'die', 'das',
]);

function matchesCompany(text: string, company: { name: string; domain?: string }): boolean {
  const haystack = text.toLowerCase();
  const tokens = company.name
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .filter((token) => token.length >= 3 && !LEGAL_FORM_TOKENS.has(token));
  if (tokens.some((token) => haystack.includes(token))) return true;
  if (company.domain) {
    const root = company.domain.toLowerCase().split('.')[0];
    if (root && root.length >= 3 && haystack.includes(root)) return true;
  }
  // 公司名全是法律形式/短词（如 "AB GmbH"）时无从校验：宁缺勿错，丢弃。
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

/**
 * Wayback availability 响应 → 快照 URL：只认 web.archive.org 的 200 快照，
 * http 归一为 https（availability API 实测返回 http://），且快照必须在
 * {@link SNAPSHOT_MAX_AGE_YEARS} 年内（过旧的档案当作没有，落回直抓层）。
 */
export function pickWaybackSnapshot(availability: unknown, nowMs = Date.now()): string | null {
  if (!availability || typeof availability !== 'object') return null;
  const snapshots = (availability as { archived_snapshots?: unknown }).archived_snapshots;
  if (!snapshots || typeof snapshots !== 'object') return null;
  const closest = (snapshots as { closest?: unknown }).closest;
  if (!closest || typeof closest !== 'object') return null;
  const { url, status } = closest as { url?: unknown; status?: unknown };
  if (typeof url !== 'string') return null;
  if (status !== undefined && String(status) !== '200') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'web.archive.org') return null;
  const stamp = /^\/web\/(\d{4})(\d{2})(\d{2})/.exec(parsed.pathname);
  if (!stamp) return null;
  const year = Number(stamp[1]);
  const month = Number(stamp[2]);
  const day = Number(stamp[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const capturedAt = Date.UTC(year, month - 1, day);
  const captured = new Date(capturedAt);
  // Date.UTC 会把 02-30 之类滚到下月：回读必须逐字段相等才是真实日期。
  if (captured.getUTCMonth() !== month - 1 || captured.getUTCDate() !== day) return null;
  if (capturedAt > nowMs + 24 * 3600_000) return null; // 未来时间戳不可信
  if (nowMs - capturedAt > SNAPSHOT_MAX_AGE_YEARS * 365 * 24 * 3600_000) return null;
  parsed.protocol = 'https:';
  return parsed.toString();
}

/**
 * 登录墙/反爬拒绝页识别（D1：被拒即停，不重试）。词表只收「墙页独有」的短语——
 * 未登录的公开个人页也带 "Join now" / "Anmelden" 导航，按导航词判墙会把正常页
 * 全部误熔断（2026-11-01 审查实测）。
 */
const SOCIAL_LOGIN_WALL =
  /authwall|checkpoint\/challenge|sign in to (view|continue|see) |bitte melden sie sich an, um|melden sie sich an, um zu (sehen|ansehen)/i;

export function isSocialLoginWall(text: string): boolean {
  return SOCIAL_LOGIN_WALL.test(text);
}

/**
 * HTML 实体单遍解码（一次扫描、每个实体只解一次）：'&amp;lt;' → '&lt;' 而不是 '<'，
 * 杜绝链式 replace 的双重反转义（CodeQL js/double-escaping）。
 */
const HTML_ENTITY = /&(?:lt|gt|quot|apos|nbsp|amp|#0*39|#x0*27);/gi;
const HTML_ENTITY_VALUE: Readonly<Record<string, string>> = Object.freeze({
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
  '&#39;': "'",
  '&#x27;': "'",
});

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(HTML_ENTITY, (entity) => {
    const lower = entity.toLowerCase();
    if (lower === '&#39;' || lower === '&#x27;') return "'";
    // 归一数字实体的前导零形（&#039; / &#x027;）。
    if (/^&#0*39;$/u.test(lower)) return "'";
    if (/^&#x0*27;$/u.test(lower)) return "'";
    return HTML_ENTITY_VALUE[lower] ?? entity;
  });
}

/** 轻量 HTML→可见文本（Trafilatura 接入前的占位清洗；纯函数可测）。 */
export function htmlToVisibleText(html: string): string {
  return decodeHtmlEntitiesOnce(
    html
      // 结束标签允许空白与属性垃圾（'</script >'、'</script\t\n bar>'——HTML 分词器同样把它们
      // 当结束标签），否则脚本正文会漏进可见文本（CodeQL js/bad-tag-filter）。
      .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** 熔断/节拍的归属键：国家子域（de./uk.）与 www 归并到注册域，避免按子域稀释熔断与限速。 */
export function socialHostKey(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/u, '').replace(/^www\./u, '');
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin.com';
  if (host === 'xing.com' || host.endsWith('.xing.com')) return 'xing.com';
  return host;
}

/** 姓名逐词折叠（小写、ß→ss、去变音、保 Unicode 字母），用于页面文本的姓名预检。 */
function foldForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 页面文本是否出现候选姓名的每个词（预检；不命中就不必发 LLM 调用）。
 *  token 同时接受德语转写与其去音标形（mueller ↔ muller），与文本折叠对齐。 */
export function pageTextMentionsName(text: string, fullName: string): boolean {
  const tokens = normalizePersonName(fullName)
    .split(' ')
    .filter(Boolean)
    .map(foldForMatch);
  if (!tokens.length || tokens.some((token) => token.length === 0)) return false;
  const haystack = ` ${foldForMatch(text)} `;
  const variantsOf = (token: string): string[] => [
    ...new Set([
      token,
      token.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u'),
    ]),
  ];
  return tokens.every((token) =>
    variantsOf(token).some((variant) => haystack.includes(` ${variant} `)),
  );
}

/** 从页面抽取结果里挑出「就是候选这个人」的记录；候选名的每个词都必须在抽取名里出现。 */
const foldTransliteration = (value: string): string =>
  value.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');

export function pickCandidatePerson(
  people: readonly ExtractedPerson[],
  candidateName: string,
): ExtractedPerson | null {
  const target = normalizePersonName(candidateName);
  if (!target) return null;
  const targetFolded = foldTransliteration(target);
  const targetFoldedTokens = targetFolded.split(' ').filter(Boolean);
  for (const person of people) {
    const name = normalizePersonName(person.full_name ?? '');
    if (!name) continue;
    const folded = foldTransliteration(name);
    if (name === target || folded === targetFolded) return person;
    const tokens = name.split(' ').filter(Boolean);
    if (targetFoldedTokens.every((token) => tokens.includes(token))) return person;
    const foldedTokens = folded.split(' ').filter(Boolean);
    if (targetFoldedTokens.every((token) => foldedTokens.includes(token))) return person;
  }
  return null;
}

/**
 * 职位取值：页面抽取（更现职）优先，但只接受像「职位」的短串（≤80 字符、≤8 个词、
 * 不含 |）；否则保留索引标题里的职务（避免被噪声页头/句子覆盖掉更好的信息）。
 */
export function choosePersonTitle(
  indexTitle: string | undefined,
  extractedTitle: string | undefined,
): string | undefined {
  const extracted = extractedTitle?.trim();
  if (
    extracted &&
    extracted.length <= 80 &&
    extracted.split(/\s+/).filter(Boolean).length <= 8 &&
    !extracted.includes('|')
  ) {
    return extracted;
  }
  return indexTitle?.trim() || undefined;
}

interface SocialCircuitOptions {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * 每域名熔断器（D1）：连续 3 次被拒（403/429/999/登录墙）→ 该域冷却 30 分钟。
 * 实例化于 registry（进程级）。只门控 L2 直抓；L1 档案层不触目标站，不受熔断影响。
 */
export class SocialHostCircuit {
  private readonly strikes = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: SocialCircuitOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  isOpen(host: string): boolean {
    const until = this.openUntil.get(host);
    if (!until) return false;
    if (this.now() >= until) {
      this.openUntil.delete(host);
      this.strikes.delete(host);
      return false;
    }
    return true;
  }

  recordRefusal(host: string): void {
    const next = (this.strikes.get(host) ?? 0) + 1;
    this.strikes.set(host, next);
    if (next >= (this.opts.threshold ?? 3)) {
      this.openUntil.set(host, this.now() + (this.opts.cooldownMs ?? 30 * 60_000));
    }
  }

  recordSuccess(host: string): void {
    this.strikes.delete(host);
    this.openUntil.delete(host);
  }
}

type ProfilePage = {
  text: string;
  sourcePage: string;
  kind: 'archive' | 'live';
};

export class SocialPresenceContactAdapter implements ContactDiscoveryAdapter {
  readonly key = 'social_presence';
  private readonly circuit: SocialHostCircuit;

  constructor(
    private readonly deps: {
      broker?: ExecutionBroker;
      gateway?: ModelGateway;
      runtimeTelemetry?: RuntimeTelemetry;
      /** 测试注入：替换 LLM 抽取（默认走网关）；缺省且无 gateway 时只保留索引层结果、不发抓取。 */
      extract?: (
        url: string,
        text: string,
        ctx: ExecutionContext,
        sellerCtx?: ContactDiscoveryContext,
      ) => Promise<ExtractedPerson[]>;
      circuit?: SocialHostCircuit;
    },
  ) {
    this.circuit = deps.circuit ?? new SocialHostCircuit();
  }

  private toolCtx(ctx: ExecutionContext): ToolContext {
    return {
      ...ctx,
      taskContractId: 'contact.find_decision_makers',
      purpose: ['discovery', 'enrichment'],
    } as unknown as ToolContext;
  }

  private extractor():
    | ((
        url: string,
        text: string,
        ctx: ExecutionContext,
        sellerCtx?: ContactDiscoveryContext,
      ) => Promise<ExtractedPerson[]>)
    | null {
    if (this.deps.extract) return this.deps.extract;
    const gateway = this.deps.gateway;
    if (!gateway) return null;
    return (url, text, ctx, sellerCtx) =>
      extractPeopleFromPage(
        gateway,
        getTask('contact.find_decision_makers'),
        { url, text, label: '社媒公开个人页文本' },
        ctx,
        {
          seller: sellerCtx?.seller,
          target_roles: sellerCtx?.targetRoles,
          offering: sellerCtx?.offering,
        },
        this.deps.runtimeTelemetry,
      );
  }

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    if (!this.deps.broker) return { contacts: [], costCents: 0 };
    const broker = this.deps.broker;
    const diagnostics: Record<string, number> = {};
    const bump = (name: string): void => {
      diagnostics[name] = (diagnostics[name] ?? 0) + 1;
    };

    // L3 索引层（M2a）：social.search 只回个人主页 URL+标题（personalData:true 的独立工具，
    // searxng.search 会把这些 URL 全部过滤掉）。
    const queries = buildSocialDorks(company, sellerCtx?.targetRoles ?? []);
    const seen = new Map<string, ProviderContactRecord>();
    for (const q of queries) {
      if (seen.size >= MAX_CONTACTS_PER_DISCOVERY_ADAPTER) break;
      try {
        const output = await broker.invoke<
          { q: string; pages?: number },
          { results: SearxResultLike[] }
        >('social.search', { q, pages: 1 }, this.toolCtx(ctx));
        for (const contact of parseSocialResults(output.data?.results ?? [], company)) {
          if (!seen.has(contact.externalId)) seen.set(contact.externalId, contact);
        }
      } catch (err) {
        rethrowIfTerminal(err);
        /* 单条 dork 失败不影响其余查询 */
      }
    }

    // L1/L2 层（M2b）：对候选个人页补档案副本→直抓，抽到的职务/部门/邮箱并入同一人记录。
    // 没有抽取器（无 gateway/测试注入）时整段跳过——不发任何无意义的外部请求。
    const extractor = this.extractor();
    if (extractor) {
      const candidates = [...seen.values()].slice(0, MAX_SOCIAL_PROFILE_FETCHES);
      for (const candidate of candidates) {
        if (!candidate.sourcePage) continue;
        let hostname: string;
        try {
          hostname = new URL(candidate.sourcePage).hostname;
        } catch {
          continue;
        }
        bump('social_fetches');
        const hostKey = socialHostKey(hostname);
        const page = await this.fetchProfilePage(candidate.sourcePage, hostname, hostKey, ctx, bump);
        if (!page) continue;
        if (!matchesCompany(page.text, company)) continue;
        if (!pageTextMentionsName(page.text, candidate.fullName)) continue;
        let people: ExtractedPerson[];
        try {
          people = await extractor(page.sourcePage, page.text, ctx, sellerCtx);
        } catch (err) {
          rethrowIfTerminal(err);
          continue;
        }
        const person = pickCandidatePerson(people, candidate.fullName);
        if (!person) continue;
        const clean = (value?: string): string | undefined => value?.trim() || undefined;
        // 邮箱/电话先在本地校验：持久化对「带不可解析邮箱」的候选整条 fail-closed，
        // 不能因为模型抄了个乱码邮箱把可靠的姓名/职务一起丢掉。
        const email = cleanEmail(person.email)?.value ?? candidate.email;
        const phone = cleanPhone(person.phone) ?? candidate.phone;
        const enriched: ProviderContactRecord = {
          ...candidate,
          title: choosePersonTitle(candidate.title, person.title),
          department: clean(person.department) ?? candidate.department,
          seniority: clean(person.seniority) ?? candidate.seniority,
          buyingRole: clean(person.buying_role) ?? candidate.buyingRole,
          isTargetRole:
            typeof person.is_target_role === 'boolean' ? person.is_target_role : candidate.isTargetRole,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          personalData: true,
          sourcePage: page.sourcePage,
          license: page.kind === 'archive' ? 'public-archive' : 'public-page',
        };
        seen.set(candidate.externalId, enriched);
        bump(page.kind === 'archive' ? 'social_archive_hits' : 'social_live_hits');
      }
    }

    return {
      contacts: [...seen.values()].slice(0, MAX_CONTACTS_PER_DISCOVERY_ADAPTER),
      costCents: 0,
      ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
    };
  }

  /** L1 档案副本（不触目标站）→ L2 LinkedIn 直抓；被拒只记 L2，且只认 403/429/999/登录墙。 */
  private async fetchProfilePage(
    url: string,
    hostname: string,
    hostKey: string,
    ctx: ExecutionContext,
    bump: (name: string) => void,
  ): Promise<ProfilePage | null> {
    const broker = this.deps.broker!;
    const snapshot = await this.lookupWaybackSnapshot(url, ctx);
    if (snapshot) {
      try {
        const archived = await broker.invoke<
          { url: string },
          { url: string; status: number; text: string }
        >('social.fetch', { url: snapshot }, this.toolCtx(ctx));
        if (archived.data?.status === 200) {
          const text = htmlToVisibleText(
            (archived.data.text ?? '').slice(0, RAW_HTML_SLICE_CHARS),
          ).slice(0, 30_000);
          if (text.length >= 120 && !isSocialLoginWall(text)) {
            return { text, sourcePage: snapshot, kind: 'archive' };
          }
        }
      } catch (err) {
        rethrowIfTerminal(err);
        /* 快照读取失败 → 落 L2 */
      }
    }

    // Xing 公开页实测是 SPA 壳（可见文本仅 "XING"），直抓无收益；只对 LinkedIn 走 L2。
    if (socialHostKey(hostname) !== 'linkedin.com') return null;
    if (this.circuit.isOpen(hostKey)) {
      bump('social_circuit_open');
      return null;
    }
    // 每域 ≤1 req/3s 由 social.fetch 工具的 perDomainCrawlDelayMs（broker/Redis）执行。
    try {
      const response = await broker.invoke<
        { url: string },
        { url: string; status: number; text: string }
      >('social.fetch', { url }, this.toolCtx(ctx));
      const status = response.data?.status ?? 0;
      // 只有目标站明确拒绝（403/429/999）与登录墙计入熔断；本地闸门（status 0）/超时不算。
      if (status === 403 || status === 429 || status === 999) {
        this.circuit.recordRefusal(hostKey);
        bump('social_blocked');
        return null;
      }
      if (status === 0 || status < 200 || status >= 300) return null;
      const text = htmlToVisibleText(
        (response.data.text ?? '').slice(0, RAW_HTML_SLICE_CHARS),
      ).slice(0, 30_000);
      if (isSocialLoginWall(text)) {
        this.circuit.recordRefusal(hostKey);
        bump('social_blocked');
        return null;
      }
      this.circuit.recordSuccess(hostKey);
      if (text.length < 120) return null;
      return { text, sourcePage: url, kind: 'live' };
    } catch (err) {
      rethrowIfTerminal(err);
      return null;
    }
  }

  private async lookupWaybackSnapshot(
    url: string,
    ctx: ExecutionContext,
  ): Promise<string | null> {
    try {
      const availability = await this.deps.broker!.invoke<
        { url: string; maxChars?: number },
        { url: string; status: number; text: string }
      >(
        'social.fetch',
        { url: `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, maxChars: 8_000 },
        this.toolCtx(ctx),
      );
      if (availability.data?.status !== 200) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(availability.data.text || 'null');
      } catch {
        return null;
      }
      return pickWaybackSnapshot(parsed);
    } catch (err) {
      rethrowIfTerminal(err);
      return null;
    }
  }
}
