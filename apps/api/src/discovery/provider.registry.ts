import { PrismaClient } from '@prisma/client';
import {
  CompanyDiscoveryAdapter,
  CompanyEnrichmentAdapter,
  ContactDiscoveryAdapter,
  EmailVerificationAdapter,
  SourceClass,
} from './provider-contract';
import { SandboxDiscoveryProvider } from './providers/sandbox.provider';
import { PublicWebDiscoveryProvider } from './providers/public-web.provider';
import { WikidataDiscoveryProvider } from './providers/wikidata.provider';
import { OsmDiscoveryProvider } from './providers/osm.provider';
import { DirectoryDiscoveryProvider } from './providers/directory.provider';
import { TradeFairDiscoveryProvider } from './providers/trade-fair.provider';
import { TedDiscoveryProvider } from './providers/ted.provider';
import { OpenFdaDiscoveryProvider } from './providers/openfda.provider';
import { DecisionMakerContactAdapter } from './providers/decision-maker.provider';
import { CompaniesHouseContactProvider } from './providers/companies-house.provider';
import { EpoOpsInventorProvider } from './providers/epo-ops.provider';
import { GleifEnrichmentProvider } from './providers/gleif.provider';
import { WikidataEnrichmentProvider } from './providers/wikidata-enrich.provider';
import { DigitalFootprintProvider } from './providers/digital-footprint.provider';
import { StructuredHarvestProvider } from './providers/structured-harvest.provider';
import { SelfHostedEmailVerifier } from './providers/email-verify.provider';
import { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker } from '../tools/tool-contract';

/** data_provider（+ 可选 source_policy）表的最小客户端面（PrismaClient 或事务客户端皆可）。 */
type ProviderDb = {
  dataProvider: PrismaClient['dataProvider'];
  sourcePolicy?: PrismaClient['sourcePolicy'];
};

/**
 * DataSourceRouter 的适配器面（PRD 8.13）：代码内注册适配器实现，
 * data_provider 表管运行状态（ENABLED/DISABLED = Kill Switch 执行点）与成本参数。
 *
 * 默认启用 **public_web**（真实公开数据挖掘：SearXNG + Crawl4AI + Gemini）。
 * sandbox 仅在 DISCOVERY_ALLOW_SANDBOX=true 时注册（用于无外网的单元/离线测试），
 * 生产与常规验证一律走真实数据。
 */
export class DiscoveryProviderRegistry {
  private readonly discovery: CompanyDiscoveryAdapter[] = [];
  private readonly contacts: ContactDiscoveryAdapter[] = [];
  private readonly emailVerifiers: EmailVerificationAdapter[] = [];
  private readonly enrichers: CompanyEnrichmentAdapter[] = [];
  /** 信号类富集（抓官网/sitemap，**慢**且**时变**）——与快事实富集分开：走独立长活动 + TTL 刷新，
   *  绝不塞进 enrichRun 的 2 分钟活动（否则 50 家 × 抓取会超时重试整段富集）。 */
  private readonly signalEnrichers: CompanyEnrichmentAdapter[] = [];

  constructor(deps?: { gateway?: ModelGateway; broker?: ExecutionBroker }) {
    const broker = deps?.broker;
    // 自建邮箱验证**排 emailVerifiers 首位**：verifyContactPoint 只用 adapters[0]，必须在
    // public_web(仅 MX→RISKY) 之前，否则新 SMTP RCPT/catch-all 逻辑永不执行。不依赖 gateway。
    // 诚实上限：Gmail/M365/catch-all/端口25不可达/catch-all未证伪 一律 RISKY，绝不谎报 VALID。
    // 收口②：**全部** provider 的原始出网统一走注入的 ToolBroker 闸门（allowedTools/
    // source_policy fail-closed/预算/限流/Trace）；无 broker = 不做任何原始出网（诚实降级空/miss）。
    this.emailVerifiers.push(new SelfHostedEmailVerifier(broker));
    if (deps?.gateway) {
      const web = new PublicWebDiscoveryProvider({ gateway: deps.gateway, broker });
      this.discovery.push(web);
      // 决策人抽取排联系人发现**首位**（调用方取 adapters[0]）：Impressum/管理层页的具名决策人
      // 优先于 public_web 的正则邮箱扫描（后者只挖到 info@，Role/Reachability 维恒零的根因之一）。
      this.contacts.push(new DecisionMakerContactAdapter({ gateway: deps.gateway, broker }));
      this.contacts.push(web);
      this.emailVerifiers.push(web);
      // 名录/列表发现（协会会员名录 + 展会参展商 + 行业目录）——同 SearXNG+Crawl4AI+Gemini 栈。
      this.discovery.push(new DirectoryDiscoveryProvider({ gateway: deps.gateway, broker }));
    }
    // 结构化开放数据源（零爬取、CC0/ODbL）——不依赖 gateway，始终可用。
    this.discovery.push(new WikidataDiscoveryProvider({ broker }));
    this.discovery.push(new OsmDiscoveryProvider({ broker }));
    // 展会参展商（逐站/逐平台模板，经 tradefair.algolia 工具拿结构化名录）——不依赖 gateway。
    this.discovery.push(new TradeFairDiscoveryProvider({ broker }));
    // TED 中标发现（欧盟采购官方 API，零鉴权，归 public_intelligence 类）——不依赖 gateway。
    // 无 CPV 过滤时 fail-safe 返回空，故对普通 public_intelligence 查询零负担。
    this.discovery.push(new TedDiscoveryProvider({ broker }));
    // openFDA 器械注册发现（美国 FDA 官方 API，零鉴权、CC0，归 public_intelligence 类）——不依赖 gateway。
    // 无 product code 过滤时 fail-safe 返回空，故对普通 public_intelligence 查询零负担。
    this.discovery.push(new OpenFdaDiscoveryProvider({ broker }));
    // UK Companies House 董事发现（待办 3 第一个身份源；官方注册处 API，Basic auth）——contact_discovery 类。
    // 不依赖 gateway（结构化 API，无 LLM）；GB 门外/无 broker/无 API key 时 fail-safe 返空（天然 no-op）。
    // 董事经 externalIds(uk-ch-officer) 走 resolvePersonIdentity Tier 0 精确并（同一董事跨源自动并成一条）。
    this.contacts.push(new CompaniesHouseContactProvider({ broker }));
    // EPO OPS 发明人发现（待办 3 第二个身份源；官方 OPS API，OAuth2）——contact_discovery 类。
    // 不依赖 gateway（结构化 API，无 LLM）；无 broker/无 creds/低置信对齐时 fail-safe 返空（天然 no-op）。
    // 发明人经归一名走 resolvePersonIdentity Tier 2/3 并（EPO 无稳定人 id → 不走 Tier 0，见设计 §3）。
    this.contacts.push(new EpoOpsInventorProvider({ broker }));
    // 富集源（对已归一公司补结构化事实）——互补并跑，均为 CC0 直连 API、零成本：
    //  wikidata = 商业事实（行业/产品/财务/官网）；gleif = 法律身份（LEI/法人形式/母子关系）。
    this.enrichers.push(new WikidataEnrichmentProvider({ broker }));
    this.enrichers.push(new GleifEnrichmentProvider({ broker }));
    // 信号类富集（v3.0，**独立长活动 enrichSignalsRun** 跑，不进 enrichRun 的 2 分钟活动）：
    //  数字足迹（官网 HTML/DNS → 技术栈/在投广告/服务市场/邮件商）+ 结构化收割（sitemap → 招聘信号）。
    //  → attributes.digital_footprint.* / .structured_harvest.*，喂 Intent/Reachability 打分。零付费。
    this.signalEnrichers.push(new DigitalFootprintProvider({ broker }));
    this.signalEnrichers.push(new StructuredHarvestProvider({ broker }));

    if (process.env.DISCOVERY_ALLOW_SANDBOX === 'true' || !deps?.gateway) {
      const sandbox = new SandboxDiscoveryProvider();
      this.discovery.push(sandbox);
      this.contacts.push(sandbox);
      this.emailVerifiers.push(sandbox);
    }
  }

  /** 平台配置表播种：让 ENABLED/DISABLED 与成本在 DB 可管。owner 连接执行。 */
  async seed(db: ProviderDb): Promise<void> {
    await db.dataProvider.upsert({
      where: { key: 'public_web' },
      update: {},
      create: { key: 'public_web', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'wikidata' },
      update: {},
      create: { key: 'wikidata', class: 'company_registry', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'openstreetmap' },
      update: {},
      create: { key: 'openstreetmap', class: 'industry_data', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'gleif' },
      update: {},
      create: { key: 'gleif', class: 'company_registry', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'directory' },
      update: {},
      create: { key: 'directory', class: 'industry_data', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'trade_fair' },
      update: {},
      create: { key: 'trade_fair', class: 'industry_data', status: 'ENABLED', costPerCallCents: 0 },
    });
    // TED 招投标（欧盟采购官方 API）——中标发现 + 招标 intent（P3）。零鉴权、costPerCallCents=0。
    await db.dataProvider.upsert({
      where: { key: 'ted' },
      update: {},
      create: { key: 'ted', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 合规注册（spec §3.3.5）：官方 REST（非爬，平台合约轨干净）；personalData=true —— notice 可能
    // 含具名联系人（即便走 API），绿事实 CC BY 4.0 署名义务、具名联系人 🔴 隔离（不入绿库）。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'api.ted.europa.eu' },
        update: {},
        create: {
          domain: 'api.ted.europa.eu',
          sourceType: 'tender',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment', 'intent'],
          retentionDays: 365,
          notes: 'TED v3 官方 Search API（零鉴权）。绿事实 CC BY 4.0 署名义务；具名联系人 🔴 隔离。intent=招标 TENDER_PUBLISHED 投影用途。',
        },
      });
    }
    // openFDA 认证注册库（美国 FDA 官方 API）——器械注册发现 + 510k intent（后续 P3）。零鉴权、costPerCallCents=0。
    await db.dataProvider.upsert({
      where: { key: 'openfda' },
      update: {},
      create: { key: 'openfda', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 合规注册（spec §3.3.7）：官方 REST（非爬）；**CC0 公共领域**（署名非义务，与 TED CC BY 不同）；
    // personalData=true —— registrationlisting 记录可能含具名 us_agent/contact（即便走 API），绿事实入库、具名个人 🔴 隔离。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'api.fda.gov' },
        update: {},
        create: {
          domain: 'api.fda.gov',
          sourceType: 'registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment', 'intent'],
          retentionDays: 365,
          notes: 'openFDA（api.fda.gov）官方开放数据 API（零鉴权）。CC0 公共领域可商用（署名非义务）；「注册≠核准」文案红线；具名 us_agent/contact 🔴 隔离；MAUDE/FAERS 不摄入。intent=510k FDA_CLEARANCE 投影用途。',
        },
      });
    }
    // 收口②：required 工具的治理域登记（未登记 fail-closed）。这些行是各直连数据源的
    // **显性合规审查记录**——SUSPENDED 任一行即该源全链停抓（Broker 单点强制）。
    if (db.sourcePolicy) {
      const requiredSourceRows = [
        { domain: 'query.wikidata.org', sourceType: 'gov_registry', termsStatus: 'REVIEWED_OK', personalData: false, notes: 'Wikidata SPARQL 端点（CC0）。wikidata.sparql 工具治理域。' },
        { domain: 'www.wikidata.org', sourceType: 'gov_registry', termsStatus: 'REVIEWED_OK', personalData: false, notes: 'Wikidata REST API（CC0）。wikidata.entity 工具治理域（富集）。' },
        { domain: 'overpass-api.de', sourceType: 'gov_registry', termsStatus: 'REVIEWED_OK', personalData: false, notes: 'OSM Overpass API（ODbL，需署名+同源共享）。osm.overpass 工具治理域（kumi 镜像同策略）。' },
        { domain: 'api.gleif.org', sourceType: 'gov_registry', termsStatus: 'REVIEWED_OK', personalData: false, notes: 'GLEIF LEI API（CC0）。gleif.fetch 工具治理域。' },
        // ⚠️ ToS 灰偏红（trade-fair-intelligence.md §0：public key 打 Algolia 撞 RX ToS §4.5(h)）。
        // 本行把既有实践变成显性登记点：termsStatus 如实标 REVIEWED_RESTRICTED，治理裁决=SUSPENDED 即全链停抓。
        { domain: 'algolia.net', sourceType: 'trade_fair', termsStatus: 'REVIEWED_RESTRICTED', personalData: true, notes: 'RX 展会参展商（Algolia 托管搜索，public search-only key）。ToS 灰偏红——风险评估见 trade-fair-intelligence.md §0；参展商记录可内联联系人（🔴 具名隔离）。' },
        { domain: 'mapyourshow.com', sourceType: 'trade_fair', termsStatus: 'UNREVIEWED', personalData: false, notes: 'MapYourShow 参展商 JSON（无鉴权公开端点，列表仅公司名/展位/描述）。mapyourshow.fetch 工具治理域。' },
      ];
      for (const row of requiredSourceRows) {
        await db.sourcePolicy.upsert({
          where: { domain: row.domain },
          update: {},
          create: {
            domain: row.domain,
            sourceType: row.sourceType,
            accessMode: 'api',
            reviewStatus: 'APPROVED',
            robotsStatus: 'ALLOWS',
            termsStatus: row.termsStatus,
            personalData: row.personalData,
            allowedPurpose: ['discovery', 'enrichment'],
            retentionDays: 365,
            notes: row.notes,
          },
        });
      }
    }
    await db.dataProvider.upsert({
      where: { key: 'digital_footprint' },
      update: {},
      create: { key: 'digital_footprint', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'structured_harvest' },
      update: {},
      create: { key: 'structured_harvest', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'smtp_self' },
      update: {},
      create: { key: 'smtp_self', class: 'email_verification', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 决策人抽取（Impressum/管理层/团队页 → 具名人+职务+买家角色）——联系人发现首选 adapter。
    await db.dataProvider.upsert({
      where: { key: 'decision_maker' },
      update: {},
      create: { key: 'decision_maker', class: 'contact_discovery', status: 'ENABLED', costPerCallCents: 0 },
    });
    // UK Companies House 董事发现（待办 3 第一个身份源）——官方注册处 API（Basic auth）。零鉴权成本、costPerCallCents=0。
    // 无 API key 时 provider fail-safe 返空即天然 no-op（key 缺失不阻断其余联系人源）。
    await db.dataProvider.upsert({
      where: { key: 'companies_house' },
      update: {},
      create: { key: 'companies_house', class: 'contact_discovery', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 合规注册：官方 REST（非爬，平台合约轨干净）；personalData=true —— officers 是具名董事（GDPR）。
    // OGL v3.0（Crown copyright）绿事实可商用**但署名是 license 义务**；数据最小化（无 DOB/国籍/住址）在 adapter 层强制。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'api.company-information.service.gov.uk' },
        update: {},
        create: {
          domain: 'api.company-information.service.gov.uk',
          sourceType: 'company_registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes: 'UK Companies House 官方注册处 API（Basic auth）。OGL v3.0（© Crown copyright）绿事实可商用但署名义务；董事 = 🔴 具名个人（GDPR），数据最小化（只取 name/role/officer_id，不摄 DOB/国籍/住址），触达前过 lawful-basis 门。',
        },
      });
    }
    // EPO OPS 发明人发现（待办 3 第二个身份源）——官方 OPS API（OAuth2 client-credentials）。costPerCallCents=0。
    // **默认 DISABLED**：OPS JSON 解析目前仅对合成 fixture 校准过，真库真 API 未跑（EPO 账号审批中）。
    // 待 `scripts/verify-epo-ops.mts` 真测通过后由 ops 手动/reseed 翻 ENABLED（`update:{}` 不覆盖手动改）。
    // verify 脚本直接 new Provider 跑、不经路由，故 DISABLED 不挡真测；DISABLED 时生产 fan-out 不路由本源（无静默错采）。
    await db.dataProvider.upsert({
      where: { key: 'epo_ops' },
      update: {},
      create: { key: 'epo_ops', class: 'contact_discovery', status: 'DISABLED', costPerCallCents: 0 },
    });
    // 合规注册：官方 REST（非爬，平台合约轨干净）；personalData=true —— inventors 是具名发明人（GDPR）。
    // CC BY 4.0 绿事实可商用**但署名是 license 义务**；数据最小化（只 name，无 residence/地址/国籍）在 adapter 层强制。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'ops.epo.org' },
        update: {},
        create: {
          domain: 'ops.epo.org',
          sourceType: 'patent_registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes: 'EPO OPS（ops.epo.org）官方开放专利服务 API（OAuth2 client-credentials）。CC BY 4.0 绿事实可商用但署名义务（Data © EPO, CC BY 4.0）；发明人 = 🔴 具名个人（GDPR），数据最小化（只 name，不摄 residence/地址/国籍），触达前过 lawful-basis 门。',
        },
      });
    }
    // 网站变更 intent 引擎（v3.0 #4，signal 源）——平台级 kill-switch/可观测（DISABLED = intentSweep 全局停抓）。
    // 注：具体监控源的常规开关是 monitored_source.status；此行是引擎级总闸 + 与其它 signal 源登记一致。
    await db.dataProvider.upsert({
      where: { key: 'web_watch' },
      update: {},
      create: { key: 'web_watch', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 自动邮箱猜测引擎级 kill-switch（选项 B P0.4）——**默认 DISABLED=关**。仅当 ENABLED **且**
    // config.lawfulBasis 有合法记录（interim 全局 LIA）时，backlog sweep 阶段⑤b 才对缺邮箱决策人自动 SMTP 探测。
    // 区别于 smtp_self（验证器 adapter，验证既有地址）：本行是「自动猜测新地址」的合规总闸（个人数据红线）。
    // **update:{}** 保证不覆盖 ops 手动改过的 status/config（开了就别被 reseed 关掉）。
    await db.dataProvider.upsert({
      where: { key: 'email_guess' },
      update: {},
      create: { key: 'email_guess', class: 'email_verification', status: 'DISABLED', costPerCallCents: 0 },
    });
    if (process.env.DISCOVERY_ALLOW_SANDBOX === 'true') {
      await db.dataProvider.upsert({
        where: { key: 'sandbox' },
        update: {},
        create: { key: 'sandbox', class: 'b2b_company_person', status: 'ENABLED', costPerCallCents: 0 },
      });
    }
  }

  /** 某 source_class 当前可用（且 ENABLED）的公司发现适配器，按成本升序。 */
  async routeCompanyDiscovery(db: ProviderDb, sourceClass: SourceClass): Promise<CompanyDiscoveryAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return this.discovery.filter((a) => a.classes.includes(sourceClass) && enabled.has(a.key));
  }

  async routeContactDiscovery(db: ProviderDb): Promise<ContactDiscoveryAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return this.contacts.filter((a) => enabled.has(a.key));
  }

  async routeEmailVerification(db: ProviderDb): Promise<EmailVerificationAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return this.emailVerifiers.filter((a) => enabled.has(a.key));
  }

  /** 当前 ENABLED 的富集适配器（对已归一公司补充结构化属性）。 */
  async routeEnrichment(db: ProviderDb): Promise<CompanyEnrichmentAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return this.enrichers.filter((a) => enabled.has(a.key));
  }

  /** 当前 ENABLED 的**信号类**富集适配器（慢/时变，走独立长活动 + TTL 刷新）。 */
  async routeSignalEnrichment(db: ProviderDb): Promise<CompanyEnrichmentAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return this.signalEnrichers.filter((a) => enabled.has(a.key));
  }

  private async enabledKeys(db: ProviderDb): Promise<Set<string>> {
    const rows = await db.dataProvider.findMany({ where: { status: 'ENABLED' }, select: { key: true } });
    return new Set(rows.map((r) => r.key));
  }
}
