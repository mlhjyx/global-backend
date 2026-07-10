import { createHash } from 'node:crypto';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
} from '../provider-contract';

const PARSER_VERSION = 'decision_maker/v1';

/** 人物页优先级（Impressum 最高——德国 §5 DDG 依法列 Geschäftsführer；然后管理层/团队）。 */
const PEOPLE_PATTERNS: { re: RegExp; w: number }[] = [
  { re: /impressum|imprint|legal-?notice|mentions-legales/i, w: 100 },
  { re: /management|leadership|vorstand|gesch(ae|ä)ftsf(ue|ü)hr|gesch(ae|ä)ftsleitung|executive|board|direktion/i, w: 95 },
  { re: /team|ansprechpartner|mitarbeiter|our-?people|\/people|\/staff/i, w: 85 },
  { re: /(ueber|über)-?uns|about-?us|\/about|unternehmen/i, w: 70 },
  { re: /kontakt|\/contact/i, w: 60 },
];
/** 常见固定路径（未被首页链接也直接试）。 */
const FIXED_PATHS = ['/impressum', '/kontakt', '/en/imprint', '/impressum.html', '/team', '/ueber-uns'];

/** 人物页优先级打分（纯函数，可测）：Impressum > 管理层 > 团队 > 关于 > 联系。0 = 非人物页。 */
export function scorePeoplePageUrl(url: string): number {
  let w = 0;
  for (const { re, w: pw } of PEOPLE_PATTERNS) if (re.test(url)) w = Math.max(w, pw);
  return w;
}

const MAX_PEOPLE_PAGES = 4;

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

interface ExtractedPeople {
  people?: {
    full_name?: string;
    title?: string;
    email?: string;
    phone?: string;
    department?: string;
    seniority?: string;
    buying_role?: string;
    is_target_role?: boolean;
    evidence?: string;
  }[];
}

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

  constructor(private readonly deps: { gateway: ModelGateway; broker?: ExecutionBroker }) {}

  private log(msg: string): void {

    console.log(`[decision_maker] ${msg}`);
  }

  /** 工具出网上下文：真租户/run 归属 + taskContractId 绑定（allowedTools 白名单生效点）。 */
  private toolCtx(ctx: ExecutionContext, taskContractId: string): ToolContext {
    return { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId, taskContractId };
  }

  /**
   * @param company.domain 目标公司域名
   * @param ctx 执行上下文（真租户/run 归属，贯穿 LLM 与工具出网）
   * @param sellerContext 卖方/ICP 摘要 + 目标买家角色（用于判 is_target_role），可选
   */
  async findDecisionMakers(
    company: { domain: string; name?: string },
    ctx: ExecutionContext,
    sellerContext?: { seller?: string; target_roles?: string[]; offering?: string },
  ): Promise<DecisionMakerContact[]> {
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级空结果。
    if (!this.deps.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return [];
    }
    const base = `https://${company.domain}/`;
    if (!(await isAllowedByRobots(base))) {
      this.log(`skip ${company.domain}: robots disallow`);
      return [];
    }

    // 1) 选人物页：首页链接里按 people-pattern 打分 + 固定路径兜底
    const pages = await this.selectPeoplePages(company.domain, base, ctx);
    if (!pages.length) return [];

    // 2) 逐页抓取 + LLM 抽取分类，按人名去重合并
    const dedup = new Map<string, DecisionMakerContact>();
    for (const url of pages.slice(0, MAX_PEOPLE_PAGES)) {
      if (!(await isAllowedByRobots(url))) continue;
      let text: string;
      try {
        const crawled = await this.deps.broker!.invoke<{ url: string }, CrawlResult>(
          'crawl4ai.fetch',
          { url },
          this.toolCtx(ctx, 'contact.find_decision_makers'),
        );
        text = crawled.data.text.slice(0, 30_000);
      } catch {
        continue;
      }
      if (text.trim().length < 120) continue;

      const people = await this.extract(url, text, ctx, sellerContext);
      for (const p of people) {
        const name = p.full_name?.trim();
        if (!name) continue;
        const key = name.toLowerCase().replace(/\s+/g, ' ');
        if (dedup.has(key)) {
          // 合并：补邮箱/电话/角色（后到只补缺）
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
          sourcePage: url,
          contentHash: createHash('sha256').update(text).digest('hex'),
          parserVersion: PARSER_VERSION,
        });
      }
    }
    const out = [...dedup.values()];
    this.log(`✓ ${company.domain}: ${out.length} named people (${out.filter((p) => p.isTargetRole).length} target-role)`);
    return out;
  }

  private async selectPeoplePages(domain: string, base: string, ctx: ExecutionContext): Promise<string[]> {
    const picked: string[] = [];
    try {
      const home = await this.deps.broker!.invoke<{ url: string }, CrawlResult>(
        'crawl4ai.fetch',
        { url: base },
        this.toolCtx(ctx, 'contact.find_decision_makers'),
      );
      const links = extractSameSiteLinks(home.data.text, base);
      const scored = links
        .map((l) => ({ l, w: scorePeoplePageUrl(l) }))
        .filter((s) => s.w > 0)
        .sort((a, b) => b.w - a.w);
      for (const s of scored) if (!picked.includes(s.l)) picked.push(s.l);
    } catch {
      // 首页抓不到也无妨，走固定路径兜底
    }
    for (const p of FIXED_PATHS) {
      const u = `https://${domain}${p}`;
      if (!picked.includes(u)) picked.push(u);
    }
    return picked.slice(0, MAX_PEOPLE_PAGES + 2);
  }

  static toContactRecords(people: DecisionMakerContact[]): ContactDiscoveryResult['contacts'] {
    return people.map((p) => ({
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
    sellerContext?: { seller?: string; target_roles?: string[]; offering?: string },
  ): Promise<NonNullable<ExtractedPeople['people']>> {
    const contract = getTask('contact.find_decision_makers');
    try {
      const result = await this.deps.gateway.generateStructured<ExtractedPeople>(
        {
          task: contract?.id ?? 'contact.find_decision_makers',
          prompt:
            `卖方/ICP 上下文（用于判断谁是目标买家角色；禁止照抄进字段）：${JSON.stringify(
              sellerContext ?? {},
            ).slice(0, 600)}\n\n` +
            `企业页面文本（URL: ${url}）：\n${text}`,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['people'] },
        },
        // 真租户归属（收口②）：ai_trace/usage_ledger 按真实 workspace 记账；runId 供预算归账。
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      return result.data?.people ?? [];
    } catch (err) {
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

  constructor(deps: { gateway: ModelGateway; broker?: ExecutionBroker }) {
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
      sellerCtx ? { seller: sellerCtx.seller, target_roles: sellerCtx.targetRoles, offering: sellerCtx.offering } : undefined,
    );
    return { contacts: DecisionMakerProvider.toContactRecords(people), costCents: 0 };
  }
}
