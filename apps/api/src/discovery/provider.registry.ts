import { PrismaClient } from '@prisma/client';
import {
  CompanyDiscoveryAdapter,
  ContactDiscoveryAdapter,
  EmailVerificationAdapter,
  SourceClass,
} from './provider-contract';
import { SandboxDiscoveryProvider } from './providers/sandbox.provider';
import { PublicWebDiscoveryProvider } from './providers/public-web.provider';
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

  constructor(deps?: { gateway?: ModelGateway }) {
    if (deps?.gateway) {
      const web = new PublicWebDiscoveryProvider({ gateway: deps.gateway });
      this.discovery.push(web);
      this.contacts.push(web);
      this.emailVerifiers.push(web);
    }
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

  private async enabledKeys(db: ProviderDb): Promise<Set<string>> {
    const rows = await db.dataProvider.findMany({ where: { status: 'ENABLED' }, select: { key: true } });
    return new Set(rows.map((r) => r.key));
  }
}
