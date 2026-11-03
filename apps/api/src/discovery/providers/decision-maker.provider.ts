import { createHash } from 'node:crypto';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import {
  ExtractedPerson,
  extractPeopleFromPage,
} from './contact-extraction';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { CrawlResult } from '../../adapters/web-crawler';
import type { HttpGetOutput } from '../../tools/source-tools';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
} from '../provider-contract';
import {
  MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
  MAX_DECISION_MAKER_PAGES,
} from '../execution-envelope';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';

const PARSER_VERSION = 'decision_maker/v1';

/** 页面文本是否值得发一次抽取（与逐页抓取的 120 字符门一致）。 */
function hasPeopleText(text: string | null): text is string {
  return typeof text === 'string' && text.trim().length >= 120;
}

/** 人物页优先级（Impressum 最高——德国 §5 DDG 依法列 Geschäftsführer；然后管理层/团队）。 */
const PEOPLE_PATTERNS: { re: RegExp; w: number }[] = [
  { re: /impressum|imprint|legal-?notice|mentions-legales/i, w: 100 },
  { re: /management|leadership|vorstand|gesch(ae|ä)ftsf(ue|ü)hr|gesch(ae|ä)ftsleitung|executive|board|direktion/i, w: 95,
  },
  { re: /team|ansprechpartner|mitarbeiter|our-?people|\/people|\/staff/i, w: 85,
  },
  { re: /(ueber|über)-?uns|about-?us|\/about|unternehmen/i, w: 70 },
  { re: /kontakt|\/contact/i, w: 60 },
];
/** 常见固定路径（未被首页链接也直接试）。 */
const FIXED_PATHS = ['/impressum', '/kontakt', '/en/imprint', '/impressum.html', '/team', '/ueber-uns'];

/**
 * 从原始 HTML 抽同站锚点（www 不敏感、去 query/hash、相对链接按 base 解析）。
 * 为什么需要：crawl4ai 的 markdown 会丢掉导航栏/JS 菜单里的链接——M5 评估里多家
 * 公司的 Impressum 在原始 HTML 有、markdown 里没有，固定路径又全是 404
 * （如 `/ando-technik/impressum/`、`common/info/impressum.html` 这类非标准路径）。
 * 保留站点给出的原始路径形态（含尾斜杠）：同一路径的两种写法可能内容不同（M5：
 * michalowski-gmbh.de 无尾斜杠形态回 39 字节反爬空壳），去重按归一化键。
 */
const MAX_ANCHOR_HTML_CHARS = 1_000_000;

export function extractAnchorsFromHtml(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const anchorsByKey = new Map<string, string>();
  // 线性扫描：逐标签找 `<a` → 最近的 `>`，属性正则在单个标签内跑。
  // 正则 `[^>]*` 在未闭合/恶意的 3MB 页面上是 O(n²)（实测 384KB 即 ~66s），
  // 会把事件循环卡死——不可信的抓取结果不能走回溯正则。
  const bounded = html.slice(0, MAX_ANCHOR_HTML_CHARS);
  const lower = bounded.toLowerCase();
  let cursor = 0;
  while (cursor < bounded.length) {
    const start = lower.indexOf('<a', cursor);
    if (start === -1) break;
    const after = bounded[start + 2];
    cursor = start + 2;
    // `<article`、`<aside` 等不是锚点。
    if (after !== undefined && !/[\s>/]/.test(after)) continue;
    const end = bounded.indexOf('>', start + 2);
    if (end === -1) break;
    const tag = bounded.slice(start, end + 1);
    cursor = end + 1;
    const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const url = new URL(raw, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      url.hash = '';
      url.search = '';
      const href = url.toString();
      const key = href.replace(/\/$/, '');
      if (!key || key === baseUrl.replace(/\/$/, '')) continue;
      // 同一页的两种写法都出现时优先带尾斜杠的形态（Map 保持首次出现的顺序）。
      const existing = anchorsByKey.get(key);
      if (existing === undefined || (href.endsWith('/') && !existing.endsWith('/'))) {
        anchorsByKey.set(key, href);
      }
    } catch {
      // unparseable href — ignore
    }
  }
  return [...anchorsByKey.values()];
}

/** 两个主机是否同一可注册域（末两段，忽略 www 大小写）：停车页/过期域名的跨站
 *  跳转不配当「公司首页的最终地址」。 */
export function sameRegistrableHost(a: string, b: string): boolean {
  const tail = (host: string): string =>
    host.toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

/** 人物页优先级打分（纯函数，可测）：Impressum > 管理层 > 团队 > 关于 > 联系。0 = 非人物页。 */
export function scorePeoplePageUrl(url: string): number {
  let w = 0;
  for (const { re, w: pw } of PEOPLE_PATTERNS) if (re.test(url)) w = Math.max(w, pw);
  return w;
}


export interface DecisionMakerContact {
  fullName: string;
  title?: string;
  email?: string;
  phone?: string;
  department?: string;
  seniority?: string;
  buyingRole?: string;
  isTargetRole: boolean;
  personalData: true; // 具名人一律个人数据 → 下游合规门（GDPR lawful basis）前置
  sourcePage: string;
  contentHash: string;
  parserVersion: string;
}

type ExtractedPeople = { people?: ExtractedPerson[] };

/**
 * 决策人抽取 Provider（获客命门：找对的人，不是 info@）。
 * 对高价值公司抓 Impressum/管理层/团队/联系页 → LLM 抽取**具名人 + 职务 + 邮箱** 并按
 * 买家委员会角色分类（对齐卖方 ICP 目标角色）。Impressum 是合规金矿（德国依法公示总经理）。
 *
 * 合规：只抽页面明确出现的人/邮箱（不推断、不编造）；具名人一律标 personalData=true，
 * 交下游 lawful-basis / suppression 门决定能否触达（尤其出海 EU）。robots 禁抓即放弃。
 */
export class DecisionMakerProvider {
  readonly key = 'decision_maker';

  constructor(private readonly deps: {
    gateway: ModelGateway;
    broker?: ExecutionBroker;
    runtimeTelemetry?: RuntimeTelemetry;
  },
  ) {}

  private log(msg: string): void {

    console.log(`[decision_maker] ${msg}`);
  }

  /** 工具出网上下文：真租户/run 归属 + taskContractId 绑定（allowedTools 白名单生效点）。 */
  private toolCtx(ctx: ExecutionContext, taskContractId: string): ToolContext {
    return { ...ctx, taskContractId };
  }

  /**
   * @param company.domain 目标公司域名
   * @param ctx 执行上下文（真租户/run 归属，贯穿 LLM 与工具出网）
   * @param sellerContext 卖方/ICP 摘要 + 目标买家角色（用于判 is_target_role），可选
   */
  async findDecisionMakers(
    company: { domain: string; name?: string },
    ctx: ExecutionContext,
    sellerContext?: {
      seller?: string;
      target_roles?: string[];
      offering?: string;
    },
  ): Promise<DecisionMakerContact[]> {
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级空结果。
    if (!this.deps.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return [];
    }
    const robotDeps = { authorizeExternalAction: ctx.authorizeExternalAction };
    let base = `https://${company.domain}/`;
    if (!(await isAllowedByRobots(base, robotDeps))) {
      // 裸域 robots.txt 的坏跳转会连累整站：Apache 少写斜杠时 Location 变成不存在的
      // 伪主机（M5：https://avag-pumpen.de/robots.txt → https://www.avag-pumpen.derobots.txt），
      // SSRF 护栏拒绝解析后被 fail-closed 成「全站禁抓」；而首页本身 301 到 www
      // origin，那里 robots 明确放行。robots 约束实际被抓取的 origin：改从同注册域
      // 的另一主机形态（裸域 ⇄ www，站点常只在其一上配好 robots）抓取并以该 origin
      // 自身 robots 为准；两个 origin 都拒绝才放弃。
      const host = company.domain.toLowerCase();
      const altHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
      const altBase = `https://${altHost}/`;
      if (!(await isAllowedByRobots(altBase, robotDeps))) {
        this.log(`skip ${company.domain}: robots disallow`);
        return [];
      }
      base = altBase;
    }

    // 1) 选人物页：首页链接里按 people-pattern 打分 + 固定路径兜底
    const selection = await this.selectPeoplePages(company.domain, base, ctx);
    if (!selection.pages.length && !hasPeopleText(selection.homeText)) return [];

    // 2) 逐页抓取 + LLM 抽取分类，按人名去重合并
    const dedup = new Map<string, DecisionMakerContact>();
    for (const url of selection.pages.slice(0, MAX_DECISION_MAKER_PAGES)) {
      if (!(await isAllowedByRobots(url, robotDeps))) continue;
      let text: string;
      try {
        const crawled = await this.deps.broker!.invoke<{ url: string }, CrawlResult>(
          'crawl4ai.fetch',
          { url },
          // FIX C（Codex P1）：显式用途，防 crawl4ai site_builder 扩宽波及决策人抓取（复现变更前有效集）。
          {
            ...this.toolCtx(ctx, 'contact.find_decision_makers'),
            purpose: ['discovery', 'enrichment'],
          },
        );
        text = crawled.data.text.slice(0, 30_000);
      } catch (err) {
        if (isExecutionControlError(err)) throw err;
        continue;
      }
      if (text.trim().length < 120) continue;

      const people = await this.extract(url, text, ctx, sellerContext);
      this.mergePeople(dedup, people, url, text);
    }
    // 2b) 兜底：小站把团队/决策人直接铺在首页（M5：jaeckel-ohg.de 的 geschäftsführende
    // Gesellschafter 只在首页团队区块出现，Impressum 反倒没有具名人）。选定的人物页
    // 一个人都没抽到时，抽取已抓到的首页文本本身。
    const homeText = selection.homeText;
    if (dedup.size === 0 && hasPeopleText(homeText)) {
      const pageText = homeText.slice(0, 30_000);
      const people = await this.extract(selection.homeUrl, pageText, ctx, sellerContext);
      this.mergePeople(dedup, people, selection.homeUrl, pageText);
    }
    const out = [...dedup.values()];
    this.log(
      `✓ ${company.domain}: ${out.length} named people (${out.filter((p) => p.isTargetRole).length} target-role)`,
    );
    return out.slice(0, MAX_CONTACTS_PER_DISCOVERY_ADAPTER);
  }

  /** 把一页的抽取结果并入去重表：姓名归一化键；后到者只补缺邮箱/电话。 */
  private mergePeople(
    dedup: Map<string, DecisionMakerContact>,
    people: ExtractedPerson[],
    sourcePage: string,
    text: string,
  ): void {
    const contentHash = createHash('sha256').update(text).digest('hex');
    for (const p of people) {
      const name = p.full_name?.trim();
      if (!name) continue;
      const key = name.toLowerCase().replace(/\s+/g, ' ');
      if (dedup.has(key)) {
        const ex = dedup.get(key)!;
        if (!ex.email && p.email) ex.email = p.email;
        if (!ex.phone && p.phone) ex.phone = p.phone;
        continue;
      }
      dedup.set(key, {
        fullName: name,
        title: p.title?.trim() || undefined,
        email: p.email?.trim() || undefined,
        phone: p.phone?.trim() || undefined,
        department: p.department || undefined,
        seniority: p.seniority || undefined,
        buyingRole: p.buying_role || undefined,
        isTargetRole: !!p.is_target_role,
        personalData: true,
        sourcePage,
        contentHash,
        parserVersion: PARSER_VERSION,
      });
    }
  }

  private async selectPeoplePages(
    domain: string,
    base: string,
    ctx: ExecutionContext,
  ): Promise<{ pages: string[]; homeUrl: string; homeText: string | null }> {
    const picked: { url: string; w: number }[] = [];
    const pickedKeys = new Set<string>();
    const addPicked = (url: string, w: number): void => {
      // www / 大小写 / 尾斜杠不敏感：markdown（按裸域解析）与原始 HTML（按 finalUrl
      // 解析）常给出同一页的两种 host 形态，去重避免占用预抓名额。
      const key = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      if (pickedKeys.has(key)) return;
      pickedKeys.add(key);
      picked.push({ url, w });
    };
    let homeText: string | null = null;
    let fixedHost = domain;
    let anchorBase = base;
    try {
      const home = await this.deps.broker!.invoke<{ url: string }, CrawlResult>(
        'crawl4ai.fetch',
        { url: base },
        // FIX C（Codex P1）：显式用途，防 crawl4ai site_builder 扩宽波及决策人抓取（复现变更前有效集）。
        {
          ...this.toolCtx(ctx, 'contact.find_decision_makers'),
          purpose: ['discovery', 'enrichment'],
        },
      );
      homeText = home.data.text ?? null;
      const links = extractSameSiteLinks(home.data.text, base);
      for (const s of links
        .map((l) => ({ l, w: scorePeoplePageUrl(l) }))
        .filter((s) => s.w > 0)) {
        addPicked(s.l, s.w);
      }
    } catch (err) {
      if (isExecutionControlError(err)) throw err;
      // 首页抓不到也无妨，走固定路径兜底
    }
    // 无论 markdown 给没给链接都用原始 HTML 补抽人物页锚点：markdown 会丢导航/JS
    // 菜单里的链接（M5：ava-berlin.de 的 markdown 恰好只有 3 条人物页链接、真实
    // Impressum 只在原始 HTML 里，按「不足 3 条才补」的旧门槛从未被选中）；同时
    // finalUrl 给出重定向后的主机（裸域→www），固定路径改用它拼，避免坏跳转。
    if (ctx.artifactSubject) {
      try {
        const raw = await this.deps.broker!.invoke<{ url: string }, HttpGetOutput>(
          'http.get',
          { url: base },
          { ...this.toolCtx(ctx, 'contact.find_decision_makers'), purpose: ['discovery', 'enrichment'] },
        );
        if (raw.data.finalUrl) {
          try {
            const finalHost = new URL(raw.data.finalUrl).host;
            // 仅当最终主机与原域同一可注册域才采纳（过期/停放域名的跨站跳转不跟）。
            if (sameRegistrableHost(finalHost, domain)) {
              fixedHost = finalHost;
              anchorBase = raw.data.finalUrl;
            }
          } catch {
            /* keep stored domain */
          }
        }
        for (const s of extractAnchorsFromHtml(raw.data.text ?? '', anchorBase)
          .map((l) => ({ l, w: scorePeoplePageUrl(l) }))
          .filter((s) => s.w > 0)) {
          addPicked(s.l, s.w);
        }
      } catch (err) {
        if (isExecutionControlError(err)) throw err;
      }
    }
    // 两路候选合并后统一按权重排序（稳定排序，同分保持 markdown 先、锚点后的原次序）：
    // 锚点里的 Impressum(100) 不能因为追加在 markdown 链接之后而被预抓名额挤掉。
    picked.sort((a, b) => b.w - a.w);
    for (const p of FIXED_PATHS) {
      addPicked(`https://${fixedHost}${p}`, 0);
    }
    return {
      pages: picked.slice(0, MAX_DECISION_MAKER_PAGES + 2).map((p) => p.url),
      homeUrl: base,
      homeText,
    };
  }

  static toContactRecords(people: DecisionMakerContact[]): ContactDiscoveryResult['contacts'] {
    return people.slice(0, MAX_CONTACTS_PER_DISCOVERY_ADAPTER).map((p) => ({
      externalId: `${p.sourcePage}#${p.fullName.toLowerCase().replace(/\s+/g, '-')}`,
      fullName: p.fullName,
      title: p.title,
      seniority: p.seniority,
      department: p.department,
      email: p.email,
      phone: p.phone,
      buyingRole: p.buyingRole,
      isTargetRole: p.isTargetRole,
      personalData: p.personalData,
      sourcePage: p.sourcePage,
    }));
  }

  private async extract(
    url: string,
    text: string,
    ctx: ExecutionContext,
    sellerContext?: {
      seller?: string;
      target_roles?: string[];
      offering?: string;
    },
  ): Promise<NonNullable<ExtractedPeople['people']>> {
    try {
      // 与 social_presence 共用的抽取入口（contact-extraction.ts）：prompt 骨架/durable schema
      // 只有一份，页面类型由 label 区分。真租户归属随 ctx 透传（ai_trace/usage_ledger 记账）。
      return await extractPeopleFromPage(
        this.deps.gateway,
        getTask('contact.find_decision_makers'),
        { url, text, label: '企业页面文本' },
        ctx,
        sellerContext,
        this.deps.runtimeTelemetry,
      );
    } catch (err) {
      if (isExecutionControlError(err)) throw err;
      this.log(`extract failed ${url}: ${String(err).slice(0, 80)}`);
      return [];
    }
  }
}

/**
 * ContactDiscoveryAdapter 包装：把决策人抽取接进 provider registry 路由（曾是死代码——
 * 实现完成却从未注册，联系人发现实际走弱的 public_web 正则）。排在 public_web 之前 =
 * 高价值公司优先拿**具名决策人**（Impressum/管理层页），而不是 info@。
 * 无域名公司无法抓官网 → 空结果（fail-safe，路由自然落到下一个 adapter 或由调用方处理）。
 */
export class DecisionMakerContactAdapter implements ContactDiscoveryAdapter {
  readonly key = 'decision_maker';
  private readonly inner: DecisionMakerProvider;

  constructor(deps: { gateway: ModelGateway; broker?: ExecutionBroker; runtimeTelemetry?: RuntimeTelemetry }) {
    this.inner = new DecisionMakerProvider(deps);
  }

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    if (!company.domain) return { contacts: [], costCents: 0 };
    const people = await this.inner.findDecisionMakers(
      { domain: company.domain, name: company.name },
      ctx,
      sellerCtx
        ? {
            seller: sellerCtx.seller,
            target_roles: sellerCtx.targetRoles,
            offering: sellerCtx.offering,
          }
        : undefined,
    );
    return {
      contacts: DecisionMakerProvider.toContactRecords(people),
      costCents: 0,
    };
  }
}
