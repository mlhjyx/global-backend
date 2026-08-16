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
import {
  FranceOfficialOrganizationDiscoveryProvider,
  NppesOrganizationDiscoveryProvider,
  RorOrganizationDiscoveryProvider,
  SecEdgarOrganizationDiscoveryProvider,
} from './providers/official-organization.providers';
import {
  BrazilPncpDiscoveryProvider,
  SingaporeGebizDiscoveryProvider,
  UkContractsFinderDiscoveryProvider,
  UkFindATenderDiscoveryProvider,
  UsaSpendingAwardsDiscoveryProvider,
  WorldBankProcurementDiscoveryProvider,
} from './providers/public-procurement.providers';
import { DecisionMakerContactAdapter } from './providers/decision-maker.provider';
import { CompaniesHouseContactProvider } from './providers/companies-house.provider';
import { InpiRneContactProvider } from './providers/inpi-rne.provider';
import { GooglePatentsInventorProvider } from './providers/bigquery-patents.provider';
import { GleifEnrichmentProvider } from './providers/gleif.provider';
import { WikidataEnrichmentProvider } from './providers/wikidata-enrich.provider';
import { SecEdgarSubmissionEnrichmentProvider } from './providers/sec-edgar-submission-enrichment.provider';
import { MexicoDenueOrganizationDiscoveryProvider } from './providers/mexico-denue.provider';
import { FmcsaQcmobileOrganizationDiscoveryProvider } from './providers/fmcsa.provider';
import { EuEcolabelOrganizationDiscoveryProvider } from './providers/eu-ecolabel.provider';
import { SbirSttrCompanyDiscoveryProvider } from './providers/sbir-sttr.provider';
import { KonepsContractBuyerDiscoveryProvider } from './providers/koneps.provider';
import { DigitalFootprintProvider } from './providers/digital-footprint.provider';
import { StructuredHarvestProvider, fetchSitemapUrls } from './providers/structured-harvest.provider';
import { SelfHostedEmailVerifier } from './providers/email-verify.provider';
import { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker, ToolContext } from '../tools/tool-contract';
import type { HttpGetInput, HttpGetOutput } from '../tools/source-tools';
import { readPatentCache, enqueuePatentLookup } from '../adapters/patent-inventor-cache';
import type { RuntimeTelemetry } from '../model-runtime/types';
import providerSourceClassManifest from './provider-source-classes.json';

/** data_provider（+ 可选 source_policy）表的最小客户端面（PrismaClient 或事务客户端皆可）。 */
type ProviderDb = {
  dataProvider: PrismaClient['dataProvider'];
  sourcePolicy?: PrismaClient['sourcePolicy'];
};

/**
 * DataSourceRouter 的适配器面（PRD 8.13）：代码内注册适配器实现，
 * data_provider 表管运行状态（ENABLED/DISABLED = Kill Switch 执行点）与成本参数。
 *
 * seed 中各 provider 的 ENABLED/DISABLED 状态才是默认路由真值；registry 注册不等于运行启用。
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

  constructor(deps?: {
    gateway?: ModelGateway;
    broker?: ExecutionBroker;
    prisma?: PrismaClient;
    runtimeTelemetry?: RuntimeTelemetry;
  }) {
    const broker = deps?.broker;
    // 专利缓存读/攒集队列 enqueue 闭包（绑 app_user prisma；平台表无 RLS）——仅当注入 prisma 时可用
    // （seed-only 构造无 prisma → cache 模式降级空，direct 仍走 broker）。读缓存零 egress、不经 broker。
    const prisma = deps?.prisma;
    const patentCacheReader = prisma
      ? (companyName: string, opts: { fromYear: number; toYear: number }) => readPatentCache(prisma, companyName, opts)
      : undefined;
    const patentEnqueue = prisma
      ? async (companyName: string, country?: string): Promise<void> => {
          await enqueuePatentLookup(prisma, { companyName, country });
        }
      : undefined;
    // 自建邮箱验证**排 emailVerifiers 首位**：verifyContactPoint 只用 adapters[0]，必须在
    // public_web(仅 MX→RISKY) 之前，否则新 SMTP RCPT/catch-all 逻辑永不执行。不依赖 gateway。
    // 诚实上限：Gmail/M365/catch-all/端口25不可达/catch-all未证伪 一律 RISKY，绝不谎报 VALID。
    // 收口②：**全部** provider 的原始出网统一走注入的 ToolBroker 闸门（allowedTools/
    // source_policy fail-closed/预算/限流/Trace）；无 broker = 不做任何原始出网（诚实降级空/miss）。
    this.emailVerifiers.push(new SelfHostedEmailVerifier(broker));
    if (deps?.gateway) {
      const web = new PublicWebDiscoveryProvider({
        gateway: deps.gateway,
        broker,
        runtimeTelemetry: deps.runtimeTelemetry,
      });
      this.discovery.push(web);
      // 决策人抽取排联系人发现首位，但调用方会 fan-out 全部 ENABLED adapter；顺序只让同 tx 持久化时
      // 优先落具名决策人，再由 public_web/Companies House 等补充并经身份解析合并。
      this.contacts.push(new DecisionMakerContactAdapter({
        gateway: deps.gateway,
        broker,
        runtimeTelemetry: deps.runtimeTelemetry,
      }));
      this.contacts.push(web);
      this.emailVerifiers.push(web);
      // 名录/列表发现（协会会员名录 + 展会参展商 + 行业目录）——同 SearXNG+Crawl4AI+Gemini 栈。
      this.discovery.push(new DirectoryDiscoveryProvider({
        gateway: deps.gateway,
        broker,
        runtimeTelemetry: deps.runtimeTelemetry,
      }));
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
    // Country/sector-gated official organization discovery. Both providers
    // fail closed without a broker and exclude upstream named-person fields.
    this.discovery.push(new FranceOfficialOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new NppesOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new RorOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new SecEdgarOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new MexicoDenueOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new FmcsaQcmobileOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new EuEcolabelOrganizationDiscoveryProvider({ broker }));
    this.discovery.push(new SbirSttrCompanyDiscoveryProvider({ broker }));
    this.discovery.push(new KonepsContractBuyerDiscoveryProvider({ broker }));
    // Procurement channels are explicit-hint only. Registration alone never
    // fans them out across every public-intelligence run.
    this.discovery.push(new WorldBankProcurementDiscoveryProvider({ broker }));
    this.discovery.push(new UsaSpendingAwardsDiscoveryProvider({ broker }));
    this.discovery.push(new UkFindATenderDiscoveryProvider({ broker }));
    this.discovery.push(new BrazilPncpDiscoveryProvider({ broker }));
    this.discovery.push(new SingaporeGebizDiscoveryProvider({ broker }));
    this.discovery.push(new UkContractsFinderDiscoveryProvider({ broker }));
    // UK Companies House 董事发现（待办 3 第一个身份源；官方注册处 API，Basic auth）——contact_discovery 类。
    // 不依赖 gateway（结构化 API，无 LLM）；GB 门外/无 broker/无 API key 时 fail-safe 返空（天然 no-op）。
    // 董事经 externalIds(uk-ch-officer) 走 resolvePersonIdentity Tier 0 精确并（同一董事跨源自动并成一条）。
    this.contacts.push(new CompaniesHouseContactProvider({ broker }));
    // 法国 dirigeants 发现（待办 3 第三个身份源；开放政务 API Recherche d'entreprises，无鉴权）——contact_discovery 类。
    // 不依赖 gateway（结构化 API，无 LLM）；FR 门外/无 broker 时 fail-safe 返空（天然 no-op）。
    // dirigeant 无 person id → 走 resolvePersonIdentity Tier 2/3 归一名并（同 EPO，非 Tier 0）。
    this.contacts.push(new InpiRneContactProvider({ broker }));
    // BigQuery Google Patents 发明人发现（待办 3 · 替代被封 EPO OPS；官方 BigQuery 公共数据集）——contact_discovery 类。
    // 不依赖 gateway（结构化查询，无 LLM）；无 broker/无 SA key/低置信对齐时 fail-safe 返空（天然 no-op）。
    // 发明人无稳定 person id → 走 resolvePersonIdentity Tier 2/3 归一名并（同 EPO/INPI，非 Tier 0，见设计 §3）。
    // scale-safe：PATENT_SOURCE_MODE=cache 时走 cacheReader（读 postgres 缓存，零 BQ 字节）+ miss enqueue；
    // =direct 走 broker（逐公司 BQ，仅 verify/调试，§8.8）；=off（默认）返空。缓存刷新由第 5 个 Temporal Schedule 驱动。
    this.contacts.push(new GooglePatentsInventorProvider({ broker, cacheReader: patentCacheReader, enqueue: patentEnqueue }));
    // 富集源（对已归一公司补结构化事实）——互补并跑，均为 CC0 直连 API、零成本：
    //  wikidata = 商业事实（行业/产品/财务/官网）；gleif = 法律身份（LEI/法人形式/母子关系）。
    this.enrichers.push(new WikidataEnrichmentProvider({ broker }));
    this.enrichers.push(new GleifEnrichmentProvider({ broker }));
    this.enrichers.push(new SecEdgarSubmissionEnrichmentProvider({ broker }));
    // 信号类富集（v3.0，**独立长活动 enrichSignalsRun** 跑，不进 enrichRun 的 2 分钟活动）：
    //  数字足迹（官网 HTML/DNS → 技术栈/在投广告/服务市场/邮件商）+ 结构化收割（sitemap → 招聘信号）。
    //  → attributes.digital_footprint.* / .structured_harvest.*，喂 Intent/Reachability 打分。零付费。
    const sitemapUrls = broker
      ? (domain: string, toolCtx: ToolContext) =>
          fetchSitemapUrls(
            domain,
            async (input: HttpGetInput) =>
              (await broker.invoke<HttpGetInput, HttpGetOutput>('http.get', input, toolCtx)).data,
          )
      : undefined;
    this.signalEnrichers.push(new DigitalFootprintProvider({ broker, sitemapUrls }));
    this.signalEnrichers.push(new StructuredHarvestProvider({ broker }));

    if (process.env.DISCOVERY_ALLOW_SANDBOX === 'true' || !deps?.gateway) {
      const sandbox = new SandboxDiscoveryProvider();
      this.discovery.push(sandbox);
      this.contacts.push(sandbox);
      this.emailVerifiers.push(sandbox);
    }
    this.assertDiscoverySourceClasses();
  }

  /** Keep the machine governance manifest bound to the classes used by routing. */
  private assertDiscoverySourceClasses(): void {
    for (const adapter of this.discovery) {
      const expected = providerSourceClassManifest[
        adapter.key as keyof typeof providerSourceClassManifest
      ] as readonly SourceClass[] | undefined;
      const actual = adapter.classes;
      const exact =
        expected !== undefined &&
        expected.length === actual.length &&
        expected.every((sourceClass) => actual.includes(sourceClass));
      if (!exact) {
        throw new Error(
          `provider source-class manifest drift for ${adapter.key}`,
        );
      }
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
    // openFDA 认证注册库（美国 FDA 官方 API）——器械注册发现 + 510k intent（均已实现）。零鉴权、costPerCallCents=0。
    await db.dataProvider.upsert({
      where: { key: 'openfda' },
      update: {},
      create: { key: 'openfda', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'fr_company' },
      update: {},
      create: { key: 'fr_company', class: 'company_registry', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'nppes' },
      update: {},
      create: { key: 'nppes', class: 'company_registry', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'ror' },
      update: { status: 'DISABLED' },
      create: { key: 'ror', class: 'company_registry', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'sec_edgar' },
      update: { status: 'DISABLED' },
      create: { key: 'sec_edgar', class: 'company_registry', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'mexico_denue' },
      update: { status: 'DISABLED' },
      create: { key: 'mexico_denue', class: 'company_registry', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'fmcsa_qcmobile' },
      update: { status: 'DISABLED' },
      create: { key: 'fmcsa_qcmobile', class: 'company_registry', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'eu_ecolabel' },
      update: { status: 'DISABLED' },
      create: { key: 'eu_ecolabel', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'sbir_sttr_companies' },
      update: { status: 'DISABLED' },
      create: { key: 'sbir_sttr_companies', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'koneps' },
      update: { status: 'DISABLED' },
      create: { key: 'koneps', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'world_bank_procurement' },
      update: {},
      create: { key: 'world_bank_procurement', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'usaspending_awards' },
      update: {},
      create: { key: 'usaspending_awards', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'uk_find_a_tender' },
      update: {},
      create: { key: 'uk_find_a_tender', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'brazil_pncp' },
      // Remain fail-closed until a real positive sample proves the full governed funnel.
      update: { status: 'DISABLED' },
      create: { key: 'brazil_pncp', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'singapore_gebiz' },
      // Research-only supplier awards are hard-disabled until they have a separate non-Lead projection.
      update: { status: 'DISABLED' },
      create: { key: 'singapore_gebiz', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    await db.dataProvider.upsert({
      where: { key: 'uk_contracts_finder' },
      update: {},
      create: { key: 'uk_contracts_finder', class: 'public_intelligence', status: 'ENABLED', costPerCallCents: 0 },
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
      await db.sourcePolicy.upsert({
        where: { domain: 'npiregistry.cms.hhs.gov' },
        update: {},
        create: {
          domain: 'npiregistry.cms.hhs.gov',
          sourceType: 'company_registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes:
            'CMS NPPES NPI Registry API v2.1。只接纳 NPI-2 organization；authorized official、电话、邮箱和街道地址在 adapter 白名单投影前结构性丢弃。NPI 表示医疗组织或 subpart，不单独证明全球法人同一性。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'api.ror.org' },
        update: {
          sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK', personalData: false, allowedPurpose: ['discovery'], retentionDays: 365,
          notes: 'ROR REST API v2 / Schema 2.1，CC0。仅显式 source_hint=ror、ISO-2 国家和官方组织类型可路由；只保留 active 组织事实。ROR ID 经 Crockford Base32 与 ISO/IEC 7064 checksum 验证后作为 ror-id 强身份；reported domains 仅为来源证据。Provider 保持 DISABLED，直至真实持久化闭环与重放验收完成。',
        },
        create: {
          domain: 'api.ror.org', sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS', termsStatus: 'REVIEWED_OK', personalData: false,
          allowedPurpose: ['discovery'], retentionDays: 365,
          notes: 'ROR REST API v2 / Schema 2.1，CC0。仅显式 source_hint=ror、ISO-2 国家和官方组织类型可路由；只保留 active 组织事实。ROR ID 经 Crockford Base32 与 ISO/IEC 7064 checksum 验证后作为 ror-id 强身份；reported domains 仅为来源证据。Provider 保持 DISABLED，直至真实持久化闭环与重放验收完成。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'www.sec.gov' },
        update: {
          sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK', personalData: false, allowedPurpose: ['discovery'], retentionDays: 365,
          notes: 'SEC EDGAR company_tickers_exchange.json 官方目录。仅精确 ticker 或精确规范名、limit 1..5、服务端真实联系 User-Agent 可调用；CIK 作为 US 证券申报命名空间身份，不证明美国住所或商业匹配。Provider 默认 DISABLED。',
        },
        create: {
          domain: 'www.sec.gov', sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS', termsStatus: 'REVIEWED_OK', personalData: false,
          allowedPurpose: ['discovery'], retentionDays: 365,
          notes: 'SEC EDGAR company_tickers_exchange.json 官方目录。仅精确 ticker 或精确规范名、limit 1..5、服务端真实联系 User-Agent 可调用；CIK 作为 US 证券申报命名空间身份，不证明美国住所或商业匹配。Provider 默认 DISABLED。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'data.sec.gov' },
        update: {
          sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK', personalData: true, allowedPurpose: ['enrichment'], retentionDays: 365,
          notes: 'SEC EDGAR submissions JSON 只可 enrichment 已有 company_tickers 目录 CIK，并要求 entityType=operating 与目录名称精确绑定；不得由 submissions 单独创建公司。filings、formerNames、地址、EIN、电话和网站结构性丢弃。Provider 默认 DISABLED。',
        },
        create: {
          domain: 'data.sec.gov', sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS', termsStatus: 'REVIEWED_OK', personalData: true,
          allowedPurpose: ['enrichment'], retentionDays: 365,
          notes: 'SEC EDGAR submissions JSON 只可 enrichment 已有 company_tickers 目录 CIK，并要求 entityType=operating 与目录名称精确绑定；不得由 submissions 单独创建公司。filings、formerNames、地址、EIN、电话和网站结构性丢弃。Provider 默认 DISABLED。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'www.inegi.org.mx' },
        update: {
          sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK', personalData: true, allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/app/api/denue/v1/consulta/Nombre/'],
          notes: 'INEGI DENUE Nombre API。仅显式 source_hint=mexico_denue、MX、州代码 01..32 和单一企业名称可调用；禁止 00/todos/全国批量。只接纳公开 Razon_social 的组织，并在 Raw 前删除电话、邮箱、详细地址、邮编、AGEB、街区和经纬度。Token 仅从进程环境读取且从 provenance/error/trace 移除。CLEE/Id 暂作 establishment 来源证据，不提升为已验证法人强身份。使用需按 INEGI 自由使用条款署名。Provider 默认 DISABLED。',
        },
        create: {
          domain: 'www.inegi.org.mx', sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS', termsStatus: 'REVIEWED_OK', personalData: true,
          allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/app/api/denue/v1/consulta/Nombre/'],
          notes: 'INEGI DENUE Nombre API。仅显式 source_hint=mexico_denue、MX、州代码 01..32 和单一企业名称可调用；禁止 00/todos/全国批量。只接纳公开 Razon_social 的组织，并在 Raw 前删除电话、邮箱、详细地址、邮编、AGEB、街区和经纬度。Token 仅从进程环境读取且从 provenance/error/trace 移除。CLEE/Id 暂作 establishment 来源证据，不提升为已验证法人强身份。使用需按 INEGI 自由使用条款署名。Provider 默认 DISABLED。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'mobile.fmcsa.dot.gov' },
        update: {
          sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'SUSPENDED', robotsStatus: 'ALLOWS',
          termsStatus: 'UNREVIEWED', personalData: true, allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/qc/services/carriers/name/'],
          notes: 'FMCSA QCMobile name API。仅显式 source_hint=fmcsa_qcmobile、US 和单一企业名称可调用；限制在前 50 条小分页，并只接纳有强法律形式或公共机构名称证据的组织承运商。电话、邮箱、详细地址、个体经营者和未知字段在 Raw 前结构性删除。WebKey 仅从进程环境读取且从 provenance/error/trace 移除。usdot-v1 仅接纳当前 1..8 位、无前导零的正十进制 QCMobile dotNumber，不宣称校验和、运营许可或支持未来编号格式。SourcePolicy 保持 SUSPENDED/UNREVIEWED 且 Provider 保持 DISABLED，直至取得 WebKey、完成条款审查及真实持久化闭环与重放验收。',
        },
        create: {
          domain: 'mobile.fmcsa.dot.gov', sourceType: 'company_registry', accessMode: 'api', reviewStatus: 'SUSPENDED',
          robotsStatus: 'ALLOWS', termsStatus: 'UNREVIEWED', personalData: true,
          allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/qc/services/carriers/name/'],
          notes: 'FMCSA QCMobile name API。仅显式 source_hint=fmcsa_qcmobile、US 和单一企业名称可调用；限制在前 50 条小分页，并只接纳有强法律形式或公共机构名称证据的组织承运商。电话、邮箱、详细地址、个体经营者和未知字段在 Raw 前结构性删除。WebKey 仅从进程环境读取且从 provenance/error/trace 移除。usdot-v1 仅接纳当前 1..8 位、无前导零的正十进制 QCMobile dotNumber，不宣称校验和、运营许可或支持未来编号格式。SourcePolicy 保持 SUSPENDED/UNREVIEWED 且 Provider 保持 DISABLED，直至取得 WebKey、完成条款审查及真实持久化闭环与重放验收。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'apps.data.env.service.ec.europa.eu' },
        update: {
          sourceType: 'certification', accessMode: 'api', reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK', personalData: true, allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/dataquery/v2/ecolabel/products'],
          notes: 'European Commission EU Ecolabel public Data Query API v2。仅显式 source_hint=eu_ecolabel、EEA 国家和精确组织名可调用；单 scope 最多 100 行，只请求组织、产品组与产品级 licence 事实。VAT、联系人、地址、坐标、图片、GTIN 和未知字段在 Raw 前结构性删除；licence number 是产品认证证据，不提升为企业身份。复用须署名并说明修改，不授予 EU Ecolabel 商标、Logo、背书或认证使用权。Provider 默认 DISABLED，直至真实持久化闭环与重放验收完成。',
        },
        create: {
          domain: 'apps.data.env.service.ec.europa.eu', sourceType: 'certification', accessMode: 'api',
          reviewStatus: 'APPROVED', robotsStatus: 'ALLOWS', termsStatus: 'REVIEWED_OK', personalData: true,
          allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/dataquery/v2/ecolabel/products'],
          notes: 'European Commission EU Ecolabel public Data Query API v2。仅显式 source_hint=eu_ecolabel、EEA 国家和精确组织名可调用；单 scope 最多 100 行，只请求组织、产品组与产品级 licence 事实。VAT、联系人、地址、坐标、图片、GTIN 和未知字段在 Raw 前结构性删除；licence number 是产品认证证据，不提升为企业身份。复用须署名并说明修改，不授予 EU Ecolabel 商标、Logo、背书或认证使用权。Provider 默认 DISABLED，直至真实持久化闭环与重放验收完成。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'api.www.sbir.gov' },
        update: {
          sourceType: 'gov_award', accessMode: 'api', reviewStatus: 'SUSPENDED', robotsStatus: 'ALLOWS',
          termsStatus: 'UNREVIEWED', personalData: true, allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/public/api/firm'],
          notes: 'SBA SBIR/STTR Company API。仅显式 source_hint=sbir_sttr_companies、US 和精确组织名可调用；只保留公司目录、州、历史 award count 与官方 profile 元数据。DUNS、街道地址、联系人、PI、所有权人口属性、公司 URL 和未知字段在 Raw 前结构性删除；UEI 仅保留为来源元数据，不提升身份。官方当前声明 API 维护中，SourcePolicy 保持 SUSPENDED/UNREVIEWED 且 Provider 保持 DISABLED。',
        },
        create: {
          domain: 'api.www.sbir.gov', sourceType: 'gov_award', accessMode: 'api', reviewStatus: 'SUSPENDED',
          robotsStatus: 'ALLOWS', termsStatus: 'UNREVIEWED', personalData: true,
          allowedPurpose: ['discovery'], retentionDays: 365, allowedPaths: ['/public/api/firm'],
          notes: 'SBA SBIR/STTR Company API。仅显式 source_hint=sbir_sttr_companies、US 和精确组织名可调用；只保留公司目录、州、历史 award count 与官方 profile 元数据。DUNS、街道地址、联系人、PI、所有权人口属性、公司 URL 和未知字段在 Raw 前结构性删除；UEI 仅保留为来源元数据，不提升身份。官方当前声明 API 维护中，SourcePolicy 保持 SUSPENDED/UNREVIEWED 且 Provider 保持 DISABLED。',
        },
      });
      await db.sourcePolicy.upsert({
        where: { domain: 'apis.data.go.kr' },
        update: {
          sourceType: 'gov_award', accessMode: 'api', reviewStatus: 'SUSPENDED', robotsStatus: 'ALLOWS',
          termsStatus: 'UNREVIEWED', personalData: true, allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch'],
          notes: 'KONEPS 物品合同采购机关 buyer 安全子集。仅显式 source_hint=koneps、KR、精确采购机关名、单一精确品名和最长 31 天窗口可调用；最多 10 页×10 行。只保留采购机关与合同事实，供应商列表、债权人、经办人、部门、电话、传真和未知字段在 Raw 前结构性删除；合同号不是企业身份。serviceKey 仅从进程环境读取并从输入、幂等键、provenance、trace 和错误链移除。官方接口免费且自动审批，但条款仍须人工确认；Provider 保持 DISABLED，直至取得 KONEPS_SERVICE_KEY 并完成真实持久化闭环与重放验收。',
        },
        create: {
          domain: 'apis.data.go.kr', sourceType: 'gov_award', accessMode: 'api', reviewStatus: 'SUSPENDED',
          robotsStatus: 'ALLOWS', termsStatus: 'UNREVIEWED', personalData: true,
          allowedPurpose: ['discovery'], retentionDays: 365,
          allowedPaths: ['/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch'],
          notes: 'KONEPS 物品合同采购机关 buyer 安全子集。仅显式 source_hint=koneps、KR、精确采购机关名、单一精确品名和最长 31 天窗口可调用；最多 10 页×10 行。只保留采购机关与合同事实，供应商列表、债权人、经办人、部门、电话、传真和未知字段在 Raw 前结构性删除；合同号不是企业身份。serviceKey 仅从进程环境读取并从输入、幂等键、provenance、trace 和错误链移除。官方接口免费且自动审批，但条款仍须人工确认；Provider 保持 DISABLED，直至取得 KONEPS_SERVICE_KEY 并完成真实持久化闭环与重放验收。',
        },
      });
      const procurementSources = [
        {
          domain: 'api.usaspending.gov',
          sourceType: 'gov_award',
          personalData: true,
          notes: 'USAspending federal award API。下属授标机构与历史中标供应商严格分角色；Recipient Name 可能是个人/个体承包商，按可能含个人数据治理。历史授标不表示当前商机，Award ID 仅为商业事件标识，不进入企业强身份。',
        },
        {
          domain: 'search.worldbank.org',
          sourceType: 'gov_opportunity',
          personalData: true,
          notes: 'World Bank Procurement Notices API。只保留采购/实施机构和公告绿事实；联系人字段结构性剔除。CC BY 4.0 署名。',
        },
        {
          domain: 'www.find-tender.service.gov.uk',
          sourceType: 'gov_opportunity',
          personalData: true,
          notes: 'UK Find a Tender OCDS API，OGL v3。买方、历史中标供应商分角色；联系人字段不进入企业绿库。',
        },
        {
          domain: 'pncp.gov.br',
          sourceType: 'gov_opportunity',
          personalData: true,
          notes: 'Brazil PNCP public consultation API。首期只输出采购机关/开放需求；仅在 CNPJ 为纯数字 14 位、校验位正确且与 numeroControlePNCP 前缀完全一致时，才投影为 br-cnpj 强身份。Provider 保持 DISABLED，直至真实正向样本完成治理闭环验收。',
        },
        {
          domain: 'data.gov.sg',
          sourceType: 'gov_award',
          personalData: true,
          notes: 'Singapore data.gov.sg GeBIZ awards dataset。只输出历史中标供应商，采购机关保留为上下文证据；supplier_name 无 UEN/entity type，按可能含个人数据治理。',
        },
        {
          domain: 'www.contractsfinder.service.gov.uk',
          sourceType: 'gov_opportunity',
          personalData: true,
          notes: 'UK Contracts Finder official OCDS GET API，OGL v3。仅用于英国低额采购买方发现，并作为 FTS 的补充。',
        },
      ];
      for (const row of procurementSources) {
        await db.sourcePolicy.upsert({
          where: { domain: row.domain },
          // Correct classification/privacy/identity notes for selected existing installs;
          // preserve every operational review/kill-switch field and all other provider rows.
          update: row.domain === 'api.usaspending.gov'
            || row.domain === 'pncp.gov.br'
            || row.domain === 'data.gov.sg'
            || row.domain === 'www.contractsfinder.service.gov.uk'
            ? { sourceType: row.sourceType, personalData: row.personalData, notes: row.notes }
            : {},
          create: {
            domain: row.domain,
            sourceType: row.sourceType,
            accessMode: 'api',
            reviewStatus: 'APPROVED',
            robotsStatus: 'ALLOWS',
            termsStatus: 'REVIEWED_OK',
            personalData: row.personalData,
            allowedPurpose: ['discovery'],
            retentionDays: 365,
            notes: row.notes,
          },
        });
      }
    }
    // 收口②：required 工具的治理域登记（未登记 fail-closed）。这些行是各直连数据源的
    // **显性合规审查记录**——SUSPENDED 任一行即该源全链停抓（Broker 单点强制）。
    if (db.sourcePolicy) {
      for (const row of [
        {
          domain: 'google.serper.dev',
          notes: 'Serper Google Search API backend for public_web candidate-domain discovery. BYOK only; no direct company/Lead projection. Keep SUSPENDED until terms review and a bounded real-key acceptance are recorded.',
        },
        {
          domain: 'api.search.brave.com',
          notes: 'Brave Search API backend for public_web candidate-domain discovery. BYOK only; no direct company/Lead projection. Keep SUSPENDED until terms review and a bounded real-key acceptance are recorded.',
        },
      ]) {
        await db.sourcePolicy.upsert({
          where: { domain: row.domain },
          update: {},
          create: {
            domain: row.domain,
            sourceType: 'search_index',
            accessMode: 'api',
            reviewStatus: 'SUSPENDED',
            robotsStatus: 'ALLOWS',
            termsStatus: 'UNREVIEWED',
            personalData: false,
            allowedPurpose: ['discovery'],
            retentionDays: 30,
            notes: row.notes,
          },
        });
      }
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
    // 法国 dirigeants 发现（待办 3 第三个身份源）——开放政务 API Recherche d'entreprises（recherche-entreprises.api.gouv.fr）。
    // **无鉴权**、costPerCallCents=0；数据源 = INPI RNE + INSEE Sirene。可本会话真测通过 → 默认 ENABLED（不同于 EPO 的 DISABLED）。
    await db.dataProvider.upsert({
      where: { key: 'inpi_rne' },
      update: {},
      create: { key: 'inpi_rne', class: 'contact_discovery', status: 'ENABLED', costPerCallCents: 0 },
    });
    // 合规注册：官方开放政务 API（非爬，平台合约轨干净）；personalData=true —— dirigeants 是具名负责人（GDPR）。
    // Licence Ouverte 2.0（Etalab）绿事实可商用**但署名是 license 义务**；数据最小化（无 DOB/国籍）在 adapter 层强制；
    // 开放网关自动排除 entreprises non-diffusibles（选择不公示者不返回）。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'recherche-entreprises.api.gouv.fr' },
        update: {},
        create: {
          domain: 'recherche-entreprises.api.gouv.fr',
          sourceType: 'company_registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes:
            "API Recherche d'entreprises（DINUM，开放政务网关，零鉴权；数据源 = INPI RNE + INSEE Sirene）。Licence Ouverte 2.0（Etalab）绿事实可商用但署名义务；dirigeant = 🔴 具名个人（GDPR），数据最小化（只取 nom/prenoms/qualite，不摄 DOB/国籍），触达前过 lawful-basis 门；非公示公司网关自动排除。",
        },
      });
    }
    // BigQuery Google Patents 发明人发现（待办 3 · 替代被封 EPO OPS）——官方 BigQuery 公共数据集查询。costPerCallCents=0。
    // **默认 DISABLED**：SQL 解析目前仅对合成 fixture 校准过，真库真 BigQuery 未跑（需 GCP 服务账号 key）。
    // 待 `scripts/verify-google-patents.mts` 真测通过后由 ops 手动/reseed 翻 ENABLED（`update:{}` 不覆盖手动改）。
    // verify 脚本直接 new Provider 跑、不经路由，故 DISABLED 不挡真测；DISABLED 时生产 fan-out 不路由本源（无静默错采）。
    await db.dataProvider.upsert({
      where: { key: 'google_patents' },
      update: {},
      create: { key: 'google_patents', class: 'contact_discovery', status: 'DISABLED', costPerCallCents: 0 },
    });
    // 合规注册：官方 BigQuery 公共数据集（非爬，平台合约轨干净）；personalData=true —— inventors 是具名发明人（GDPR）。
    // CC BY 4.0 绿事实可商用**但署名是 license 义务**（⚠️ ENABLE 前按数据集元数据核实确切文案）；
    // 数据最小化（只 name，无 residence/国籍）在 adapter 层强制；成本护栏 maximumBytesBilled 硬顶护 1TB/月免费额度。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'bigquery.googleapis.com' },
        update: {},
        create: {
          domain: 'bigquery.googleapis.com',
          sourceType: 'patent_registry',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes:
            'BigQuery Google Patents Public Data（bigquery.googleapis.com；patents-public-data.patents.publications，IFI CLAIMS 谐调）。服务账号鉴权 + maximumBytesBilled 成本护栏（护 1TB/月免费额度）。CC BY 4.0 绿事实可商用但署名义务（Google Patents Public Data / IFI CLAIMS，⚠️ ENABLE 前核实确切文案）；发明人 = 🔴 具名个人（GDPR），数据最小化（只 name，不摄 residence/国籍），触达前过 lawful-basis 门。scale-safe #89：逐公司查改走 postgres scoped 缓存（patent_inventor_cache）——一次共享大扫落库、逐公司零 BQ 字节读；缓存 inventorName 列级 encryptPii 落盘 + 盲键 inventorNameKey，TTL≤180d（严于 retentionDays）到期/出窗自动清理，Art.17 擦除按盲键扫描面命中删。§8.8 用途门刷新侧自守（SUSPENDED→DENIED 不扫）。🔴 翻 ENABLED（缓存把 lawful-basis 门前 PII 静态化多一存储面）须用户先签 LIA/DPIA——在此之前 data_provider.google_patents=DISABLED 且 PATENT_SOURCE_MODE=off。',
        },
      });
    }
    // SAM.gov Sources Sought（美国联邦招标前意图，P4）——keyless 公开 CSV（datagov 分区）。
    // **默认 DISABLED**：实现与历史验证不等于当前运行授权；启用前须重核合规、配置、限额和真实运行门。
    // SAM 不物化 PII（联系官不入库、买方=联邦机构组织），但这不绕过 provider kill-switch 与受控 pilot 审批。
    await db.dataProvider.upsert({
      where: { key: 'samgov' },
      update: {},
      create: { key: 'samgov', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
    });
    // 合规注册：keyless 公开 CSV（非爬网页）；美国政府作品公共领域（署名非义务，同 openFDA CC0）；
    // personalData=true —— CSV 含联系官具名字段（adapter+mapper 双层结构性剔除，绿库只落机构/公告事实）。
    if (db.sourcePolicy) {
      await db.sourcePolicy.upsert({
        where: { domain: 'sam.gov' },
        update: {},
        create: {
          domain: 'sam.gov',
          sourceType: 'gov_opportunity',
          accessMode: 'api',
          reviewStatus: 'APPROVED',
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment', 'intent'],
          retentionDays: 365,
          notes:
            'SAM.gov Contract Opportunities 公开数据抽取（datagov 分区，keyless api_key=null → 预签名 S3）。只经公开 CSV/API，绝不爬网页 UI、绝不触敏感端点。美国政府作品公共领域（17 U.S.C. §105，署名非义务）；「Sources Sought=市场调研非招标」市场信号红线；联系官（PrimaryContact*/SecondaryContact*）= 🔴 具名个人，adapter+mapper 双层结构性剔除不入绿库；买方=联邦机构（法人组织）。intent=Sources Sought US_FED_SOURCES_SOUGHT 投影用途。',
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

  /** 某 source_class 当前 ENABLED 的公司发现适配器，保持显式注册顺序；调用方负责 fan-out。 */
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
    return this.enrichers.filter((a) => a.key !== 'sec_edgar' && enabled.has(a.key));
  }

  /**
   * ICP 资格门前的小范围事实路由。这不是新渠道，只是从已登记的富集源中
   * 选出 Wikidata、GLEIF 法律身份和官网数字足迹；招聘/站点收割仍留在后续阶段。
   */
  async routeFitEvidenceEnrichment(db: ProviderDb): Promise<CompanyEnrichmentAdapter[]> {
    const enabled = await this.enabledKeys(db);
    return [...this.enrichers, ...this.signalEnrichers].filter(
      (adapter) =>
        (adapter.key === 'wikidata' || adapter.key === 'gleif' || adapter.key === 'sec_edgar' || adapter.key === 'digital_footprint') &&
        enabled.has(adapter.key),
    );
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
