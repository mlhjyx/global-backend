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
import { GleifEnrichmentProvider } from './providers/gleif.provider';
import { WikidataEnrichmentProvider } from './providers/wikidata-enrich.provider';
import { ModelGateway } from '../model-gateway/model-gateway';

/** data_provider 表的最小客户端面（PrismaClient 或事务客户端皆可）。 */
type ProviderDb = { dataProvider: PrismaClient['dataProvider'] };

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

  constructor(deps?: { gateway?: ModelGateway }) {
    if (deps?.gateway) {
      const web = new PublicWebDiscoveryProvider({ gateway: deps.gateway });
      this.discovery.push(web);
      this.contacts.push(web);
      this.emailVerifiers.push(web);
      // 名录/列表发现（协会会员名录 + 展会参展商 + 行业目录）——同 SearXNG+Crawl4AI+Gemini 栈。
      this.discovery.push(new DirectoryDiscoveryProvider({ gateway: deps.gateway }));
    }
    // 结构化开放数据源（零爬取、CC0/ODbL）——不依赖 gateway，始终可用。
    this.discovery.push(new WikidataDiscoveryProvider());
    this.discovery.push(new OsmDiscoveryProvider());
    // 展会参展商（逐站/逐平台模板，直连托管搜索 API 拿结构化名录）——不依赖 gateway。
    this.discovery.push(new TradeFairDiscoveryProvider());
    // 富集源（对已归一公司补结构化事实）——互补并跑，均为 CC0 直连 API、零成本：
    //  wikidata = 商业事实（行业/产品/财务/官网）；gleif = 法律身份（LEI/法人形式/母子关系）。
    this.enrichers.push(new WikidataEnrichmentProvider());
    this.enrichers.push(new GleifEnrichmentProvider());

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

  private async enabledKeys(db: ProviderDb): Promise<Set<string>> {
    const rows = await db.dataProvider.findMany({ where: { status: 'ENABLED' }, select: { key: true } });
    return new Set(rows.map((r) => r.key));
  }
}
